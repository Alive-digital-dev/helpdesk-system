const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Database connection
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root', 
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'helpdesk',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;

// Initialize database
async function initDatabase() {
    try {
        pool = mysql.createPool(dbConfig);
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully');
        
        // Create tables
        const tables = [
            `CREATE TABLE IF NOT EXISTS organizations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                plan ENUM('starter', 'professional', 'enterprise') DEFAULT 'starter',
                status ENUM('active', 'inactive') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                role ENUM('super_admin', 'org_admin', 'manager', 'agent') NOT NULL,
                organization_id INT,
                status ENUM('active', 'inactive') DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id)
            )`,
            `CREATE TABLE IF NOT EXISTS customers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                full_name VARCHAR(255),
                organization_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id),
                UNIQUE KEY unique_customer (email, phone, organization_id)
            )`,
            `CREATE TABLE IF NOT EXISTS tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_number VARCHAR(50) UNIQUE NOT NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                status ENUM('new', 'open', 'pending', 'resolved', 'closed') DEFAULT 'new',
                priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
                channel ENUM('email', 'chat', 'whatsapp', 'sms', 'phone', 'form') NOT NULL,
                customer_id INT NOT NULL,
                organization_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id),
                FOREIGN KEY (organization_id) REFERENCES organizations(id)
            )`,
            `CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                sender_type ENUM('customer', 'agent', 'system', 'ai') NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id)
            )`
        ];
        
        for (const table of tables) {
            await connection.execute(table);
        }
        
        // Create default admin
        const [existing] = await connection.execute('SELECT id FROM users WHERE role = ?', ['super_admin']);
        if (existing.length === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await connection.execute(
                'INSERT INTO users (email, password, full_name, role) VALUES (?, ?, ?, ?)',
                ['admin@helpdesk.com', hashedPassword, 'System Administrator', 'super_admin']
            );
            console.log('✅ Default admin created: admin@helpdesk.com / admin123');
        }
        
        connection.release();
    } catch (error) {
        console.error('❌ Database error:', error);
    }
}

const JWT_SECRET = process.env.JWT_SECRET || 'helpdesk-secret-change-this';

// Routes
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        service: 'HelpDesk System',
        timestamp: new Date().toISOString()
    });
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!pool) return res.status(500).json({ error: 'Database not connected' });
        
        const connection = await pool.getConnection();
        const [users] = await connection.execute(
            'SELECT * FROM users WHERE email = ? AND status = ?',
            [email, 'active']
        );
        connection.release();
        
        if (users.length === 0 || !await bcrypt.compare(password, users[0].password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = users[0];
        const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        
        res.json({
            token,
            user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role }
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Customer login
app.post('/api/auth/customer-login', async (req, res) => {
    try {
        const { email, phone } = req.body;
        if (!pool) return res.status(500).json({ error: 'Database not connected' });
        
        const connection = await pool.getConnection();
        const [customers] = await connection.execute(
            'SELECT * FROM customers WHERE email = ? AND phone = ?',
            [email, phone]
        );
        connection.release();
        
        if (customers.length === 0) {
            return res.status(401).json({ error: 'Customer not found' });
        }
        
        const customer = customers[0];
        const token = jwt.sign({ customerId: customer.id, type: 'customer' }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({
            token,
            customer: { id: customer.id, email: customer.email, fullName: customer.full_name }
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Create ticket
app.post('/api/tickets', async (req, res) => {
    try {
        const { title, description, customerEmail, customerPhone, customerName } = req.body;
        if (!pool) return res.status(500).json({ error: 'Database not connected' });
        
        const connection = await pool.getConnection();
        await connection.beginTransaction();
        
        try {
            // Create customer if not exists
            let [customers] = await connection.execute(
                'SELECT id FROM customers WHERE email = ? AND phone = ?',
                [customerEmail, customerPhone]
            );
            
            let customerId;
            if (customers.length === 0) {
                const [result] = await connection.execute(
                    'INSERT INTO customers (email, phone, full_name, organization_id) VALUES (?, ?, ?, ?)',
                    [customerEmail, customerPhone, customerName, 1]
                );
                customerId = result.insertId;
            } else {
                customerId = customers[0].id;
            }
            
            // Create ticket
            const ticketNumber = 'HD-' + Date.now();
            const [ticketResult] = await connection.execute(
                'INSERT INTO tickets (ticket_number, title, description, customer_id, organization_id, channel) VALUES (?, ?, ?, ?, ?, ?)',
                [ticketNumber, title, description, customerId, 1, 'form']
            );
            
            await connection.commit();
            connection.release();
            
            res.json({ ticketId: ticketResult.insertId, ticketNumber });
        } catch (error) {
            await connection.rollback();
            connection.release();
            throw error;
        }
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get tickets
app.get('/api/tickets', async (req, res) => {
    try {
        if (!pool) return res.status(500).json({ error: 'Database not connected' });
        
        const connection = await pool.getConnection();
        const [tickets] = await connection.execute(
            'SELECT t.*, c.full_name as customer_name, c.email as customer_email FROM tickets t LEFT JOIN customers c ON t.customer_id = c.id ORDER BY t.created_at DESC'
        );
        connection.release();
        
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Start server
async function startServer() {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 HelpDesk server running on port ${PORT}`);
        console.log(`🌐 Health check: http://localhost:${PORT}/api/health`);
    });
}

startServer().catch(console.error);
