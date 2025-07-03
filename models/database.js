const mysql = require('mysql2/promise');

class Database {
    constructor() {
        this.pool = null;
        this.isInitialized = false;
    }

    async initialize() {
        try {
            // Create connection pool
            if (process.env.DATABASE_URL) {
                this.pool = mysql.createPool(process.env.DATABASE_URL);
            } else {
                this.pool = mysql.createPool({
                    host: process.env.DB_HOST || 'localhost',
                    user: process.env.DB_USER || 'root',
                    password: process.env.DB_PASSWORD || '',
                    database: process.env.DB_NAME || 'helpdesk',
                    waitForConnections: true,
                    connectionLimit: 10,
                    queueLimit: 0
                });
            }

            console.log('🔄 Initializing database...');
            const connection = await this.pool.getConnection();
            
            // Create all tables
            await this.createTables(connection);
            await this.createDefaultData(connection);
            
            connection.release();
            this.isInitialized = true;
            console.log('✅ Database initialized successfully');
            
        } catch (error) {
            console.error('❌ Database initialization failed:', error);
            throw error;
        }
    }

    async createTables(connection) {
        const tables = [
            // Organizations table
            `CREATE TABLE IF NOT EXISTS organizations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(20),
                plan ENUM('free', 'starter', 'professional', 'enterprise') DEFAULT 'free',
                status ENUM('active', 'inactive', 'suspended', 'trial') DEFAULT 'trial',
                trial_end_date TIMESTAMP NULL,
                monthly_ticket_limit INT DEFAULT 50,
                monthly_ticket_count INT DEFAULT 0,
                reset_date DATE,
                billing_email VARCHAR(255),
                billing_address TEXT,
                settings JSON,
                ai_enabled BOOLEAN DEFAULT true,
                whatsapp_enabled BOOLEAN DEFAULT false,
                sms_enabled BOOLEAN DEFAULT false,
                custom_domain VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
                permissions JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )`,

            // Subscription plans
            `CREATE TABLE IF NOT EXISTS subscription_plans (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                price_monthly DECIMAL(10,2) NOT NULL,
                price_yearly DECIMAL(10,2),
                ticket_limit INT NOT NULL,
                agent_limit INT,
                features JSON,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,

            // Customers with enhanced fields
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
                UNIQUE KEY unique_customer_org (email, phone, organization_id)
            )`,

            // Enhanced tickets table
            `CREATE TABLE IF NOT EXISTS tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_number VARCHAR(50) UNIQUE NOT NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                status ENUM('new', 'open', 'pending', 'waiting_customer', 'resolved', 'closed') DEFAULT 'new',
                priority ENUM('low', 'medium', 'high', 'urgent', 'critical') DEFAULT 'medium',
                category VARCHAR(100),
                subcategory VARCHAR(100),
                channel ENUM('email', 'chat', 'whatsapp', 'sms', 'phone', 'form', 'ai_assistant') NOT NULL,
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
                ai_summary TEXT,
                ai_suggested_actions JSON,
                view_count INT DEFAULT 0,
                last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
                FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )`,

            // Enhanced messages table
            `CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                conversation_id VARCHAR(100),
                sender_type ENUM('customer', 'agent', 'system', 'ai', 'webhook') NOT NULL,
                sender_id INT,
                sender_name VARCHAR(255),
                sender_email VARCHAR(255),
                content TEXT NOT NULL,
                content_type ENUM('text', 'html', 'markdown') DEFAULT 'text',
                message_type ENUM('message', 'note', 'system', 'auto_response', 'ai_suggestion') DEFAULT 'message',
                visibility ENUM('public', 'internal', 'private') DEFAULT 'public',
                attachments JSON,
                ai_generated BOOLEAN DEFAULT FALSE,
                ai_confidence DECIMAL(3,2),
                translation JSON,
                sentiment_score DECIMAL(3,2),
                read_by JSON,
                edited_at TIMESTAMP NULL,
                deleted_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL
            )`,

            // AI Conversations
            `CREATE TABLE IF NOT EXISTS ai_conversations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                session_id VARCHAR(100) UNIQUE NOT NULL,
                customer_id INT,
                organization_id INT NOT NULL,
                conversation_data JSON,
                messages JSON,
                intent VARCHAR(100),
                entities JSON,
                sentiment VARCHAR(20),
                confidence_score DECIMAL(3,2),
                status ENUM('active', 'completed', 'escalated', 'abandoned') DEFAULT 'active',
                ticket_created INT,
                escalation_reason TEXT,
                satisfaction_rating INT,
                ai_model VARCHAR(50) DEFAULT 'gpt-3.5-turbo',
                total_messages INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
                FOREIGN KEY (ticket_created) REFERENCES tickets(id) ON DELETE SET NULL
            )`,

            // Billing and usage
            `CREATE TABLE IF NOT EXISTS billing_usage (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id INT NOT NULL,
                month_year VARCHAR(7) NOT NULL,
                tickets_created INT DEFAULT 0,
                ai_messages INT DEFAULT 0,
                sms_sent INT DEFAULT 0,
                whatsapp_sent INT DEFAULT 0,
                storage_used BIGINT DEFAULT 0,
                overage_tickets INT DEFAULT 0,
                overage_cost DECIMAL(10,2) DEFAULT 0,
                total_cost DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
                UNIQUE KEY unique_org_month (organization_id, month_year)
            )`,

            // System settings
            `CREATE TABLE IF NOT EXISTS system_settings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                setting_key VARCHAR(100) UNIQUE NOT NULL,
                setting_value TEXT,
                data_type ENUM('string', 'number', 'boolean', 'json') DEFAULT 'string',
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )`
        ];

        for (const [index, table] of tables.entries()) {
            await connection.execute(table);
            console.log(`  📋 Table ${index + 1}/${tables.length} ready`);
        }
    }

    async createDefaultData(connection) {
        // Create subscription plans
        const plans = [
            ['free', 0, 0, 50, 1, '{"ai": false, "whatsapp": false, "sms": false, "priority_support": false}'],
            ['starter', 99, 999, 500, 5, '{"ai": true, "whatsapp": false, "sms": false, "priority_support": false}'],
            ['professional', 299, 2999, 2000, 25, '{"ai": true, "whatsapp": true, "sms": true, "priority_support": true}'],
            ['enterprise', 999, 9999, 10000, 100, '{"ai": true, "whatsapp": true, "sms": true, "priority_support": true, "custom_domain": true}']
        ];

        for (const [name, monthly, yearly, tickets, agents, features] of plans) {
            await connection.execute(
                'INSERT IGNORE INTO subscription_plans (name, price_monthly, price_yearly, ticket_limit, agent_limit, features) VALUES (?, ?, ?, ?, ?, ?)',
                [name, monthly, yearly, tickets, agents, features]
            );
        }

        // Create super admin
        const [existingAdmin] = await connection.execute(
            'SELECT id FROM users WHERE role = ?',
            ['super_admin']
        );

        if (existingAdmin.length === 0) {
            const bcrypt = require('bcryptjs');
            const hashedPassword = await bcrypt.hash('admin123', 12);
            await connection.execute(
                'INSERT INTO users (email, password, full_name, role) VALUES (?, ?, ?, ?)',
                ['admin@helpdesk.com', hashedPassword, 'System Administrator', 'super_admin']
            );
            console.log('✅ Super admin created: admin@helpdesk.com / admin123');
        }

        // Create demo organization
        const [existingOrg] = await connection.execute(
            'SELECT id FROM organizations WHERE email = ?',
            ['demo@helpdesk.com']
        );

        if (existingOrg.length === 0) {
            const [orgResult] = await connection.execute(
                'INSERT INTO organizations (name, email, plan, status, monthly_ticket_limit) VALUES (?, ?, ?, ?, ?)',
                ['Demo Organization', 'demo@helpdesk.com', 'professional', 'active', 2000]
            );

            const demoOrgId = orgResult.insertId;

            // Create demo org admin
            const bcrypt = require('bcryptjs');
            const hashedPassword = await bcrypt.hash('demo123', 12);
            await connection.execute(
                'INSERT INTO users (email, password, full_name, role, organization_id) VALUES (?, ?, ?, ?, ?)',
                ['admin@demo.com', hashedPassword, 'Demo Admin', 'org_admin', demoOrgId]
            );

            // Create demo customer
            await connection.execute(
                'INSERT INTO customers (email, phone, full_name, organization_id) VALUES (?, ?, ?, ?)',
                ['customer@demo.com', '050-1234567', 'Demo Customer', demoOrgId]
            );

            console.log('✅ Demo organization created');
        }

        // System settings
        const settings = [
            ['system_name', 'HelpDesk Pro', 'string', 'System name'],
            ['default_language', 'he', 'string', 'Default language'],
            ['max_file_size', '10485760', 'number', 'Max file upload size in bytes'],
            ['ai_enabled', 'true', 'boolean', 'Global AI assistant enabled'],
            ['registration_enabled', 'true', 'boolean', 'New organization registration enabled']
        ];

        for (const [key, value, type, description] of settings) {
            await connection.execute(
                'INSERT IGNORE INTO system_settings (setting_key, setting_value, data_type, description) VALUES (?, ?, ?, ?)',
                [key, value, type, description]
            );
        }
    }

    async getConnection() {
        if (!this.pool) {
            throw new Error('Database not initialized');
        }
        return this.pool.getConnection();
    }

    async query(sql, params = []) {
        const connection = await this.getConnection();
        try {
            const [results] = await connection.execute(sql, params);
            return results;
        } finally {
            connection.release();
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            this.isInitialized = false;
        }
    }
}

module.exports = new Database();
