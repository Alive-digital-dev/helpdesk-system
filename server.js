const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"]
        }
    }
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Basic middleware
app.use(compression());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

// Database connection
let pool;

async function initDatabase() {
    try {
        // Create connection pool
        if (process.env.DATABASE_URL) {
            pool = mysql.createPool(process.env.DATABASE_URL + '?ssl=false');
        } else {
            pool = mysql.createPool({
                host: process.env.DB_HOST || 'localhost',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: process.env.DB_NAME || 'helpdesk',
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0
            });
        }
        
        console.log('🔄 Connecting to database...');
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully');
        
        // Create all tables
        await createTables(connection);
        await createDefaultData(connection);
        
        connection.release();
    } catch (error) {
        console.error('❌ Database error:', error);
    }
}

// Create database tables
async function createTables(connection) {
    const tables = [
        // Organizations table
        `CREATE TABLE IF NOT EXISTS organizations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            phone VARCHAR(20),
            plan ENUM('starter', 'professional', 'enterprise', 'custom') DEFAULT 'starter',
            status ENUM('active', 'inactive', 'suspended', 'trial') DEFAULT 'trial',
            monthly_tickets_limit INT DEFAULT 100,
            monthly_tickets_used INT DEFAULT 0,
            monthly_reset_date DATE,
            billing_cycle ENUM('monthly', 'yearly') DEFAULT 'monthly',
            trial_end_date DATE,
            settings JSON,
            ai_enabled BOOLEAN DEFAULT TRUE,
            custom_domain VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_org_email (email),
            INDEX idx_org_status (status),
            INDEX idx_org_plan (plan)
        )`,
        
        // Users table with enhanced roles
        `CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            full_name VARCHAR(255) NOT NULL,
            phone VARCHAR(20),
            role ENUM('super_admin', 'org_admin', 'manager', 'agent') NOT NULL,
            organization_id INT,
            department VARCHAR(100),
            skills JSON,
            status ENUM('active', 'inactive', 'vacation') DEFAULT 'active',
            avatar VARCHAR(255),
            timezone VARCHAR(50) DEFAULT 'Asia/Jerusalem',
            language VARCHAR(10) DEFAULT 'he',
            last_login TIMESTAMP NULL,
            last_activity TIMESTAMP NULL,
            notification_preferences JSON,
            working_hours JSON,
            two_factor_enabled BOOLEAN DEFAULT FALSE,
            two_factor_secret VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
            INDEX idx_user_email (email),
            INDEX idx_user_org (organization_id),
            INDEX idx_user_role (role),
            INDEX idx_user_status (status)
        )`,
        
        // Customers table
        `CREATE TABLE IF NOT EXISTS customers (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL,
            phone VARCHAR(20) NOT NULL,
            full_name VARCHAR(255),
            organization_id INT NOT NULL,
            customer_id VARCHAR(100),
            status ENUM('active', 'inactive', 'blocked') DEFAULT 'active',
            priority ENUM('normal', 'vip', 'enterprise') DEFAULT 'normal',
            tags JSON,
            custom_fields JSON,
            notes TEXT,
            total_tickets INT DEFAULT 0,
            satisfaction_rating DECIMAL(3,2),
            last_contact TIMESTAMP NULL,
            preferred_language VARCHAR(10) DEFAULT 'he',
            timezone VARCHAR(50) DEFAULT 'Asia/Jerusalem',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
            UNIQUE KEY unique_customer_org (email, phone, organization_id),
            INDEX idx_customer_org (organization_id),
            INDEX idx_customer_email (email),
            INDEX idx_customer_phone (phone)
        )`,
        
        // Tickets table with comprehensive fields
        `CREATE TABLE IF NOT EXISTS tickets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ticket_number VARCHAR(50) UNIQUE NOT NULL,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            status ENUM('new', 'open', 'pending', 'waiting_customer', 'resolved', 'closed') DEFAULT 'new',
            priority ENUM('low', 'medium', 'high', 'urgent', 'critical') DEFAULT 'medium',
            category VARCHAR(100),
            subcategory VARCHAR(100),
            channel ENUM('email', 'chat', 'whatsapp', 'sms', 'phone', 'form', 'api', 'ai') NOT NULL,
            source VARCHAR(100),
            customer_id INT NOT NULL,
            assigned_to INT,
            assigned_group VARCHAR(100),
            organization_id INT NOT NULL,
            escalation_level INT DEFAULT 0,
            sla_due_date TIMESTAMP NULL,
            first_response_at TIMESTAMP NULL,
            resolved_at TIMESTAMP NULL,
            closed_at TIMESTAMP NULL,
            response_time_minutes INT,
            resolution_time_minutes INT,
            satisfaction_rating INT,
            satisfaction_comment TEXT,
            tags JSON,
            custom_fields JSON,
            internal_notes TEXT,
            external_notes TEXT,
            attachment_count INT DEFAULT 0,
            view_count INT DEFAULT 0,
            ai_generated BOOLEAN DEFAULT FALSE,
            ai_confidence DECIMAL(3,2),
            last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
            FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
            INDEX idx_ticket_number (ticket_number),
            INDEX idx_ticket_org (organization_id),
            INDEX idx_ticket_status (status),
            INDEX idx_ticket_priority (priority),
            INDEX idx_ticket_assigned (assigned_to),
            INDEX idx_ticket_customer (customer_id),
            INDEX idx_ticket_created (created_at),
            INDEX idx_ticket_sla (sla_due_date)
        )`,
        
        // Messages table for ticket conversations
        `CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ticket_id INT NOT NULL,
            sender_type ENUM('customer', 'agent', 'system', 'ai', 'webhook') NOT NULL,
            sender_id INT,
            sender_name VARCHAR(255),
            sender_email VARCHAR(255),
            content TEXT NOT NULL,
            content_type ENUM('text', 'html', 'markdown') DEFAULT 'text',
            message_type ENUM('message', 'note', 'system', 'auto_response', 'ai_suggestion') DEFAULT 'message',
            visibility ENUM('public', 'internal', 'private') DEFAULT 'public',
            file_attachments JSON,
            ai_generated BOOLEAN DEFAULT FALSE,
            ai_confidence DECIMAL(3,2),
            translation JSON,
            sentiment_score DECIMAL(3,2),
            read_by JSON,
            edited_at TIMESTAMP NULL,
            deleted_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
