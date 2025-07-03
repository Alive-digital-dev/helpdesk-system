const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Import database model
const db = require('./models/database');

const app = express();
const PORT = process.env.PORT || 8080;

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'helpdesk-secret';

// Middleware for token authentication
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Access token required' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Invalid token' });
        }
        
        // Convert token data to match database structure
        req.user = {
            id: user.userId,
            email: user.email,
            role: user.role,
            organization_id: user.organizationId
        };
        next();
    });
};

// Routes
app.get('/api/health', async (req, res) => {
    try {
        let dbStatus = 'disconnected';
        let stats = { organizations: 0, tickets: 0 };
        
        if (db.isInitialized) {
            try {
                const orgs = await db.query('SELECT COUNT(*) as count FROM organizations');
                const tickets = await db.query('SELECT COUNT(*) as count FROM tickets');
                stats = { 
                    organizations: orgs[0]?.count || 0, 
                    tickets: tickets[0]?.count || 0 
                };
                dbStatus = 'connected';
            } catch (err) {
                dbStatus = 'error: ' + err.message;
            }
        }
        
        res.json({ 
            success: true,
            status: 'OK', 
            service: 'HelpDesk Pro SaaS with ARIA',
            database: dbStatus,
            stats,
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            aria_version: '1.0.0'
        });
    } catch (error) {
        res.status(500).json({ 
            success: false,
            status: 'ERROR', 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// User login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email and password required' 
            });
        }
        
        const users = await db.query(
            'SELECT * FROM users WHERE email = ? AND status = ?',
            [email, 'active']
        );
        
        if (users.length === 0) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid credentials' 
            });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid credentials' 
            });
        }
        
        const token = jwt.sign(
            { 
                userId: user.id,
                email: user.email,
                role: user.role,
                organizationId: user.organization_id
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.full_name,
                role: user.role,
                organization_id: user.organization_id
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// Customer login for portal (simple email + phone verification)
app.post('/api/auth/customer-login', async (req, res) => {
    try {
        const { email, phone } = req.body;
        
        if (!email || !phone) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email and phone required' 
            });
        }
        
        const customers = await db.query(
            'SELECT * FROM customers WHERE email = ? AND phone = ?',
            [email, phone]
        );
        
        if (customers.length === 0) {
            return res.status(401).json({ 
                success: false, 
                message: 'לקוח לא נמצא עם הפרטים שצוינו' 
            });
        }
        
        const customer = customers[0];
        
        // Create simple token for customer
        const token = jwt.sign(
            { 
                customerId: customer.id,
                email: customer.email,
                organizationId: customer.organization_id,
                type: 'customer'
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            customer: {
                id: customer.id,
                email: customer.email,
                name: customer.full_name,
                phone: customer.phone,
                organizationId: customer.organization_id
            }
        });
    } catch (error) {
        console.error('Customer login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// Authentication endpoints נוספים עבור ARIA
app.get('/api/auth/verify', authenticateToken, async (req, res) => {
    try {
        const [user] = await db.query(
            'SELECT id, full_name as name, email, role, organization_id FROM users WHERE id = ?',
            [req.user.id]
        );
        
        if (user.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }
        
        res.json({ success: true, user: user[0] });
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// Get current user info for ARIA
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const [user] = await db.query(
            'SELECT id, full_name as name, email, role, organization_id FROM users WHERE id = ?',
            [req.user.id]
        );
        
        if (user.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'User not found' 
            });
        }
        
        res.json(user[0]);
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error' 
        });
    }
});

// ARIA Routes - מערכת AI מתקדמת
app.use('/api/aria', authenticateToken, require('./routes/aria'));

// Create ticket
app.post('/api/tickets', async (req, res) => {
    try {
        const { title, description, customerEmail, customerPhone, customerName } = req.body;
        
        if (!title || !description || !customerEmail || !customerPhone) {
            return res.status(400).json({ 
                success: false, 
                message: 'Required fields missing' 
            });
        }
        
        // Generate ticket number
        const ticketNumber = 'HD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5).toUpperCase();
        
        // For now, use organization 1
        const organizationId = 1;
        
        // Create or get customer
        let customers = await db.query(
            'SELECT id FROM customers WHERE email = ? AND phone = ?',
            [customerEmail, customerPhone]
        );
        
        let customerId;
        if (customers.length === 0) {
            const result = await db.query(
                'INSERT INTO customers (email, phone, full_name, organization_id) VALUES (?, ?, ?, ?)',
                [customerEmail, customerPhone, customerName, organizationId]
            );
            customerId = result.insertId;
        } else {
            customerId = customers[0].id;
        }
        
        // Create ticket
        const ticketResult = await db.query(
            'INSERT INTO tickets (ticket_number, title, description, customer_id, organization_id, channel) VALUES (?, ?, ?, ?, ?, ?)',
            [ticketNumber, title, description, customerId, organizationId, 'form']
        );
        
        res.json({
            success: true,
            ticketId: ticketResult.insertId,
            ticketNumber,
            message: 'Ticket created successfully'
        });
        
    } catch (error) {
        console.error('Create ticket error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to create ticket' 
        });
    }
});

// Get tickets
app.get('/api/tickets', async (req, res) => {
    try {
        const tickets = await db.query(
            `SELECT t.*, c.full_name as customer_name, c.email as customer_email 
             FROM tickets t 
             LEFT JOIN customers c ON t.customer_id = c.id 
             ORDER BY t.created_at DESC 
             LIMIT 50`
        );
        
        res.json({ success: true, tickets });
    } catch (error) {
        console.error('Get tickets error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch tickets' 
        });
    }
});

// Static files routing - ARIA pages
app.get('/aria-login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'aria-login.html'));
});

app.get('/aria-dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'aria-dashboard.html'));
});

// Static routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        path: req.originalUrl,
        message: 'הנתיב שביקשת לא נמצא במערכת'
    });
});

// Start server
async function startServer() {
    try {
        await db.initialize();
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 HelpDesk Pro with ARIA running on port ${PORT}`);
            console.log(`🌐 Landing page: http://localhost:${PORT}`);
            console.log(`🤖 ARIA Login: http://localhost:${PORT}/aria-login.html`);
            console.log(`📊 ARIA Dashboard: http://localhost:${PORT}/aria-dashboard.html`);
            console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        // Don't exit - let Railway restart
    }
}

startServer().catch(console.error);
