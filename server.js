const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database connection
let pool;

// Simple connection using DATABASE_URL
async function initDatabase() {
    try {
        if (process.env.DATABASE_URL) {
            pool = mysql.createPool(process.env.DATABASE_URL);
        } else {
            pool = mysql.createPool({
                host: process.env.DB_HOST || 'localhost',
                user: process.env.DB_USER || 'root', 
                password: process.env.DB_PASSWORD || '',
                database: process.env.DB_NAME || 'helpdesk'
            });
        }
        
        console.log('🔄 Connecting to database...');
        const connection = await pool.getConnection();
        console.log('✅ Database connected successfully');
        
        // Create admin table and user
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Check if admin exists
        const [existing] = await connection.execute('SELECT id FROM users WHERE email = ?', ['admin@helpdesk.com']);
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

// Routes
app.get('/api/health', async (req, res) => {
    try {
        let dbStatus = 'disconnected';
        if (pool) {
            const connection = await pool.getConnection();
            dbStatus = 'connected';
            connection.release();
        }
        
        res.json({ 
            status: 'OK', 
            service: 'HelpDesk System',
            database: dbStatus,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({ 
            status: 'OK', 
            service: 'HelpDesk System',
            database: 'error',
            timestamp: new Date().toISOString()
        });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!pool) {
            return res.status(500).json({ error: 'Database not connected' });
        }
        
        const connection = await pool.getConnection();
        const [users] = await connection.execute('SELECT * FROM users WHERE email = ?', [email]);
        connection.release();
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign(
            { userId: user.id, email: user.email, role: user.role },
            'helpdesk-secret',
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                fullName: user.full_name,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found: ' + req.originalUrl });
});

// Start server
async function startServer() {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 HelpDesk server running on port ${PORT}`);
        console.log(`🌐 Health check: http://localhost:${PORT}/api/health`);
        console.log(`🔐 Login endpoint: http://localhost:${PORT}/api/auth/login`);
    });
}

startServer().catch(console.error);
