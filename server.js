const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const moment = require('moment');
require('dotenv').config();

// Import our database model
const db = require('./models/database');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(helmet({ 
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false 
}));
app.use(compression());
app.use(morgan('combined'));
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// File upload configuration
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'helpdesk-super-secret-change-in-production';

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
}

// Role-based access control
function requireRole(roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

// Helper function to generate ticket number
function generateTicketNumber() {
    return 'HD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5).toUpperCase();
}

// Helper function to check organization limits
async function checkOrganizationLimits(orgId, type = 'ticket') {
    try {
        const [org] = await db.query('SELECT * FROM organizations WHERE id = ?', [orgId]);
        if (!org) return { allowed: false, reason: 'Organization not found' };
        
        if (type === 'ticket') {
            const currentMonth = moment().format('YYYY-MM');
            const [usage] = await db.query(
                'SELECT * FROM billing_usage WHERE organization_id = ? AND month_year = ?',
                [orgId, currentMonth]
            );
            
            const currentUsage = usage ? usage.tickets_created : 0;
            const limit = org.monthly_ticket_limit;
            
            if (currentUsage >= limit) {
                return { allowed: false, reason: 'Monthly ticket limit exceeded', current: currentUsage, limit };
            }
            
            return { allowed: true, current: currentUsage, limit };
        }
        
        return { allowed: true };
    } catch (error) {
        console.error('Error checking limits:', error);
        return { allowed: false, reason: 'System error' };
    }
}

// Update organization usage
async function updateOrganizationUsage(orgId, type, count = 1) {
    try {
        const currentMonth = moment().format('YYYY-MM');
        
        // Insert or update usage record
        await db.query(
            `INSERT INTO billing_usage (organization_id, month_year, ${type}) 
             VALUES (?, ?, ?) 
             ON DUPLICATE KEY UPDATE ${type} = ${type} + ?`,
            [orgId, currentMonth, count, count]
        );
        
        // Update organization monthly count
        if (type === 'tickets_created') {
            await db.query(
                'UPDATE organizations SET monthly_ticket_count = monthly_ticket_count + ? WHERE id = ?',
                [count, orgId]
            );
        }
    } catch (error) {
        console.error('Error updating usage:', error);
    }
}

// Routes

// Health check with database status
app.get('/api/health', async (req, res) => {
    try {
        let dbStatus = 'disconnected';
        let organizationCount = 0;
        let ticketCount = 0;
        
        if (db.isInitialized) {
            try {
                const [orgs] = await db.query('SELECT COUNT(*) as count FROM organizations');
                const [tickets] = await db.query('SELECT COUNT(*) as count FROM tickets');
                organizationCount = orgs.count;
                ticketCount = tickets.count;
                dbStatus = 'connected';
            } catch (err) {
                dbStatus = 'error';
            }
        }
        
        res.json({ 
            status: 'OK', 
            service: 'HelpDesk Pro SaaS',
            database: dbStatus,
            organizations: organizationCount,
            tickets: ticketCount,
            timestamp: new Date().toISOString(),
            version: '2.0.0'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'ERROR', 
            service: 'HelpDesk Pro SaaS',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Authentication routes

// Login for users (admin, agents, etc.)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        const users = await db.query(
            'SELECT u.*, o.name as organization_name, o.plan as organization_plan FROM users u LEFT JOIN organizations o ON u.organization_id = o.id WHERE u.email = ? AND u.status = ?',
            [email, 'active']
        );
        
        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Update last login
        await db.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        
        const token = jwt.sign(
            { 
                userId: user.id,
                email: user.email,
                role: user.role,
                organizationId: user.organization_id,
                fullName: user.full_name
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
                fullName: user.full_name,
                role: user.role,
                organizationId: user.organization_id,
                organizationName: user.organization_name,
                organizationPlan: user.organization_plan
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Customer login (email + phone)
app.post('/api/auth/customer-login', async (req, res) => {
    try {
        const { email, phone, organizationId = 1 } = req.body;
        
        if (!email || !phone) {
            return res.status(400).json({ error: 'Email and phone required' });
        }
        
        const customers = await db.query(
            'SELECT c.*, o.name as organization_name FROM customers c LEFT JOIN organizations o ON c.organization_id = o.id WHERE c.email = ? AND c.phone = ? AND c.organization_id = ? AND c.status = ?',
            [email, phone, organizationId, 'active']
        );
        
        if (customers.length === 0) {
            return res.status(401).json({ error: 'Customer not found' });
        }
        
        const customer = customers[0];
        const token = jwt.sign(
            { 
                customerId: customer.id,
                email: customer.email,
                type: 'customer',
                organizationId: customer.organization_id,
                fullName: customer.full_name
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        
        res.json({
            success: true,
            token,
            customer: {
                id: customer.id,
                email: customer.email,
                fullName: customer.full_name,
                phone: customer.phone,
                organizationId: customer.organization_id,
                organizationName: customer.organization_name
            }
        });
    } catch (error) {
        console.error('Customer login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Organization registration
app.post('/api/auth/register-organization', async (req, res) => {
    try {
        const { 
            organizationName,
            adminEmail,
            adminPassword,
            adminFullName,
            adminPhone,
            plan = 'free'
        } = req.body;
        
        if (!organizationName || !adminEmail || !adminPassword || !adminFullName) {
            return res.status(400).json({ error: 'All fields required' });
        }
        
        // Check if email already exists
        const existingUsers = await db.query('SELECT id FROM users WHERE email = ?', [adminEmail]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        const connection = await db.getConnection();
        await connection.beginTransaction();
        
        try {
            // Get plan details
            const [planDetails] = await db.query('SELECT * FROM subscription_plans WHERE name = ?', [plan]);
            if (!planDetails) {
                throw new Error('Invalid plan selected');
            }
            
            // Create organization
            const [orgResult] = await connection.execute(
                'INSERT INTO organizations (name, email, plan, monthly_ticket_limit, trial_end_date) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 14 DAY))',
                [organizationName, adminEmail, plan, planDetails.ticket_limit]
            );
            
            const organizationId = orgResult.insertId;
            
            // Create admin user
            const hashedPassword = await bcrypt.hash(adminPassword, 12);
            await connection.execute(
                'INSERT INTO users (email, password, full_name, phone, role, organization_id) VALUES (?, ?, ?, ?, ?, ?)',
                [adminEmail, hashedPassword, adminFullName, adminPhone, 'org_admin', organizationId]
            );
            
            await connection.commit();
            connection.release();
            
            res.json({ 
                success: true,
                message: 'Organization registered successfully',
                organizationId,
                plan: planDetails
            });
            
        } catch (error) {
            await connection.rollback();
            connection.release();
            throw error;
        }
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: error.message || 'Registration failed' });
    }
});

// Ticket management

// Create ticket
app.post('/api/tickets', async (req, res) => {
    try {
        const {
            title,
            description,
            priority = 'medium',
            category,
            channel = 'form',
            customerEmail,
            customerPhone,
            customerName,
            organizationId = 1
        } = req.body;
        
        if (!title || !description || !customerEmail || !customerPhone) {
            return res.status(400).json({ error: 'Required fields missing' });
        }
        
        // Check organization limits
        const limitCheck = await checkOrganizationLimits(organizationId, 'ticket');
        if (!limitCheck.allowed) {
            return res.status(400).json({ error: limitCheck.reason, current: limitCheck.current, limit: limitCheck.limit });
        }
        
        const connection = await db.getConnection();
        await connection.beginTransaction();
        
        try {
            // Create or get customer
            let customers = await db.query(
                'SELECT id FROM customers WHERE email = ? AND phone = ? AND organization_id = ?',
                [customerEmail, customerPhone, organizationId]
            );
            
            let customerId;
            if (customers.length === 0) {
                const [customerResult] = await connection.execute(
                    'INSERT INTO customers (email, phone, full_name, organization_id) VALUES (?, ?, ?, ?)',
                    [customerEmail, customerPhone, customerName, organizationId]
                );
                customerId = customerResult.insertId;
            } else {
                customerId = customers[0].id;
            }
            
            // Generate ticket number
            const ticketNumber = generateTicketNumber();
            
            // Create ticket
            const [ticketResult] = await connection.execute(
                'INSERT INTO tickets (ticket_number, title, description, priority, category, channel, customer_id, organization_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [ticketNumber, title, description, priority, category, channel, customerId, organizationId]
            );
            
            const ticketId = ticketResult.insertId;
            
            // Create initial message
            await connection.execute(
                'INSERT INTO messages (ticket_id, sender_type, content, message_type) VALUES (?, ?, ?, ?)',
                [ticketId, 'customer', description, 'message']
            );
            
            // Update customer ticket count
            await connection.execute(
                'UPDATE customers SET total_tickets = total_tickets + 1 WHERE id = ?',
                [customerId]
            );
            
            await connection.commit();
            connection.release();
            
            // Update organization usage
            await updateOrganizationUsage(organizationId, 'tickets_created', 1);
            
            res.json({
                success: true,
                ticketId,
                ticketNumber,
                customerId,
                message: 'Ticket created successfully'
            });
            
        } catch (error) {
            await connection.rollback();
            connection.release();
            throw error;
        }
        
    } catch (error) {
        console.error('Create ticket error:', error);
        res.status(500).json({ error: 'Failed to create ticket' });
    }
});

// Get tickets
app.get('/api/tickets', authenticateToken, async (req, res) => {
    try {
        const { status, priority, limit = 50, offset = 0, organizationId } = req.query;
        
        let whereConditions = [];
        let params = [];
        
        // Organization filter
        if (req.user.role === 'super_admin') {
            if (organizationId) {
                whereConditions.push('t.organization_id = ?');
                params.push(organizationId);
            }
        } else {
            whereConditions.push('t.organization_id = ?');
            params.push(req.user.organizationId);
        }
        
        // Status filter
        if (status) {
            whereConditions.push('t.status = ?');
            params.push(status);
        }
        
        // Priority filter
        if (priority) {
            whereConditions.push('t.priority = ?');
            params.push(priority);
        }
        
        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
        
        params.push(parseInt(limit), parseInt(offset));
        
        const tickets = await db.query(
            `SELECT 
                t.*,
                c.full_name as customer_name,
                c.email as customer_email,
                c.phone as customer_phone,
                u.full_name as assigned_agent_name,
                o.name as organization_name
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            LEFT JOIN users u ON t.assigned_to = u.id
            LEFT JOIN organizations o ON t.organization_id = o.id
            ${whereClause}
            ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
            params
        );
        
        res.json({ success: true, tickets });
    } catch (error) {
        console.error('Get tickets error:', error);
        res.status(500).json({ error: 'Failed to fetch tickets' });
    }
});

// Dashboard statistics
app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
    try {
        let orgFilter = '';
        let params = [];
        
        if (req.user.role !== 'super_admin') {
            orgFilter = 'WHERE organization_id = ?';
            params.push(req.user.organizationId);
        }
        
        const [ticketStats] = await db.query(
            `SELECT 
                COUNT(*) as total_tickets,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_tickets,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_tickets,
                SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_tickets,
                SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) as urgent_tickets
            FROM tickets ${orgFilter}`,
            params
        );
        
        const [userStats] = await db.query(
            `SELECT 
                COUNT(*) as total_users,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_users
            FROM users ${orgFilter}`,
            params
        );
        
        res.json({ 
            success: true, 
            stats: {
                ...ticketStats,
                ...userStats
            }
        });
    } catch (error) {
        console.error('Dashboard stats error:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// AI Assistant endpoint
app.post('/api/ai/chat', async (req, res) => {
    try {
        const { message, sessionId, customerId, organizationId } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }
        
        // Simple AI response logic (you can integrate with OpenAI later)
        let aiResponse = '';
        const lowerMessage = message.toLowerCase();
        
        if (lowerMessage.includes('בעיה') || lowerMessage.includes('תקלה')) {
            aiResponse = 'הבנתי שיש לך בעיה טכנית. אני יכול לעזור לך לפתוח פניה חדשה. האם תוכל לתאר את הבעיה בפירוט?';
        } else if (lowerMessage.includes('נציג')) {
            aiResponse = 'כמובן! אני מחבר אותך לנציג אנושי. זה ייקח כמה דקות.';
        } else if (lowerMessage.includes('שלום') || lowerMessage.includes('היי')) {
            aiResponse = 'שלום! אני העוזר הדיגיטלי שלך. איך אני יכול לעזור לך היום?';
        } else {
            aiResponse = 'הבנתי את הודעתך. האם תרצה שאפתח לך פניה חדשה או שאחבר אותך לנציג?';
        }
        
        // Save conversation if sessionId provided
        if (sessionId) {
            const conversationData = {
                messages: [
                    { type: 'user', content: message, timestamp: new Date().toISOString() },
                    { type: 'ai', content: aiResponse, timestamp: new Date().toISOString() }
                ]
            };
            
            await db.query(
                `INSERT INTO ai_conversations (session_id, customer_id, organization_id, conversation_data, total_messages) 
                 VALUES (?, ?, ?, ?, ?) 
                 ON DUPLICATE KEY UPDATE 
                 conversation_data = JSON_MERGE(conversation_data, ?), 
                 total_messages = total_messages + 2`,
                [sessionId, customerId, organizationId, JSON.stringify(conversationData), 2, JSON.stringify(conversationData)]
            );
        }
        
        res.json({
            success: true,
            response: aiResponse,
            sessionId,
            suggestions: [
                'פתח פניה חדשה',
                'דבר עם נציג',
                'בדוק סטטוס פניה קיימת'
            ]
        });
        
    } catch (error) {
        console.error('AI chat error:', error);
        res.status(500).json({ error: 'AI service temporarily unavailable' });
    }
});

// Static routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/customer', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Route not found',
        path: req.originalUrl,
        method: req.method
    });
});

// Error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Initialize database and start server
async function startServer() {
    try {
        await db.initialize();
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 HelpDesk Pro SaaS server running on port ${PORT}`);
            console.log(`🌐 Landing page: http://localhost:${PORT}`);
            console.log(`👨‍💼 Admin panel: http://localhost:${PORT}/admin`);
            console.log(`👤 Customer portal: http://localhost:${PORT}/customer`);
            console.log(`📝 Registration: http://localhost:${PORT}/signup`);
            console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    await db.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully');
    await db.close();
    process.exit(0);
});

startServer().catch(console.error);
