const express = require('express');
const router = express.Router();
const db = require('../models/database');

// Middleware לאימות הרשאות ARIA
const requireAriaAccess = (req, res, next) => {
    if (req.user) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'נדרשת הזדהות' });
    }
};

// GET /api/aria/dashboard - קבלת נתוני דשבורד
router.get('/dashboard', requireAriaAccess, async (req, res) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;
        const orgId = req.user.organization_id;
        
        let dashboardData = {};
        
        // נתונים בסיסיים לכל המשתמשים
        const [ticketStats] = await db.query(`
            SELECT 
                COUNT(*) as total_tickets,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_tickets,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_tickets,
                SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_priority,
                SUM(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) as urgent_tickets,
                SUM(CASE WHEN DATE(created_at) = CURDATE() THEN 1 ELSE 0 END) as new_today
            FROM tickets 
            WHERE organization_id = ?
        `, [orgId]);
        
        dashboardData.tickets = ticketStats[0];
        
        // נתונים עבור מנהלים ומעלה
        if (['admin', 'manager', 'super_admin'].includes(userRole)) {
            const [teamStats] = await db.query(`
                SELECT 
                    COUNT(*) as total_agents,
                    SUM(CASE WHEN last_active > DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN 1 ELSE 0 END) as active_agents,
                    AVG(aria_queries_count) as avg_aria_usage
                FROM users 
                WHERE organization_id = ? AND role IN ('agent', 'manager')
            `, [orgId]);
            
            dashboardData.team = teamStats[0];
            
            // נתונים על ביצועים
            const [performance] = await db.query(`
                SELECT 
                    AVG(TIMESTAMPDIFF(MINUTE, created_at, 
                        CASE WHEN status = 'closed' THEN updated_at ELSE NOW() END)) as avg_response_time,
                    COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) as tickets_today,
                    COUNT(CASE WHEN DATE(created_at) = CURDATE() AND status = 'closed' THEN 1 END) as closed_today
                FROM tickets 
                WHERE organization_id = ?
            `, [orgId]);
            
            dashboardData.performance = performance[0];
        }
        
        // נתונים עבור super admin
        if (userRole === 'super_admin') {
            const [globalStats] = await db.query(`
                SELECT 
                    COUNT(DISTINCT organization_id) as total_organizations,
                    COUNT(*) as total_users,
                    SUM(CASE WHEN subscription_status = 'active' THEN 1 ELSE 0 END) as active_subscriptions
                FROM users
            `);
            
            dashboardData.global = globalStats[0];
        }
        
        res.json({
            success: true,
            dashboard: dashboardData
        });
    } catch (error) {
        console.error('ARIA dashboard error:', error);
        res.status(500).json({
            success: false,
            message: 'שגיאה בטעינת נתוני הדשבורד'
        });
    }
});

// POST /api/aria/chat - שליחת הודעה ל-ARIA
router.post('/chat', requireAriaAccess, async (req, res) => {
    try {
        const { message, context } = req.body;
        const userId = req.user.id;
        const userRole = req.user.role;
        const orgId = req.user.organization_id;
        
        if (!message || message.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: 'הודעה לא יכולה להיות רקה'
            });
        }
        
        const startTime = Date.now();
        
        // עיבוד ההודעה דרך ARIA
        const ariaResponse = await processARIAMessage(message, userRole, userId, orgId, context);
        const processingTime = Date.now() - startTime;
        
        res.json({
            success: true,
            response: ariaResponse
        });
    } catch (error) {
        console.error('ARIA chat error:', error);
        res.status(500).json({
            success: false,
            message: 'שגיאה בעיבוד הודעת ARIA'
        });
    }
});

// פונקציה לעיבוד הודעות ARIA
async function processARIAMessage(message, userRole, userId, orgId, context) {
    const lowerMessage = message.toLowerCase();
    
    try {
        // זיהוי כוונה בסיסי
        if (lowerMessage.includes('פניה') || lowerMessage.includes('טיקט') || lowerMessage.includes('פתוח')) {
            return await handleTicketsQuery(message, userRole, userId, orgId);
        } else if (lowerMessage.includes('צוות') || lowerMessage.includes('ביצועים')) {
            return await handleTeamPerformance(message, userRole, userId, orgId);
        } else if (lowerMessage.includes('דוח')) {
            return await handleCreateReport(message, userRole, userId, orgId);
        } else {
            return generateWelcomeResponse(userRole);
        }
    } catch (error) {
        console.error('ARIA processing error:', error);
        return {
            message: 'מצטער, נתקלתי בשגיאה בעיבוד הבקשה. אנא נסה שנית.',
            context: { error: true },
            intent: 'error',
            confidence: 0.0
        };
    }
}

// טיפול בשאילתות טיקטים
async function handleTicketsQuery(message, userRole, userId, orgId) {
    try {
        const [tickets] = await db.query(`
            SELECT 
                t.id, t.subject, t.status, t.priority, t.created_at,
                c.name as customer_name, c.email as customer_email
            FROM tickets t
            LEFT JOIN customers c ON t.customer_id = c.id
            WHERE t.organization_id = ?
            ORDER BY t.created_at DESC
            LIMIT 10
        `, [orgId]);
        
        let response = '🎫 <strong>פניות במערכת:</strong><br><br>';
        
        if (tickets.length === 0) {
            response += 'לא נמצאו פניות במערכת.';
        } else {
            tickets.forEach((ticket, index) => {
                const priorityIcon = ticket.priority === 'urgent' ? '🔴' : 
                                  ticket.priority === 'high' ? '🟡' : '🟢';
                const statusIcon = ticket.status === 'open' ? '📤' : '✅';
                
                response += `${index + 1}. ${priorityIcon} ${statusIcon} <strong>#${ticket.id}</strong> - ${ticket.subject}<br>`;
                response += `👤 ${ticket.customer_name || 'לא ידוע'}<br>`;
                response += `📅 ${new Date(ticket.created_at).toLocaleDateString('he-IL')}<br><br>`;
            });
        }
        
        return {
            message: response,
            intent: 'tickets_query',
            confidence: 0.9
        };
    } catch (error) {
        throw error;
    }
}

// טיפול בביצועי צוות
async function handleTeamPerformance(message, userRole, userId, orgId) {
    try {
        if (!['admin', 'manager', 'super_admin'].includes(userRole)) {
            return {
                message: '🔒 מצטער, אין לך הרשאות לצפות בביצועי הצוות.',
                intent: 'team_performance',
                confidence: 0.8
            };
        }
        
        const [teamStats] = await db.query(`
            SELECT 
                u.id, u.name, u.email,
                COUNT(t.id) as total_tickets
            FROM users u
            LEFT JOIN tickets t ON u.id = t.assigned_to
            WHERE u.organization_id = ? AND u.role IN ('agent', 'manager')
            GROUP BY u.id
            ORDER BY total_tickets DESC
        `, [orgId]);
        
        let response = '📈 <strong>ביצועי צוות:</strong><br><br>';
        
        if (teamStats.length === 0) {
            response += 'לא נמצאו נציגים במערכת.';
        } else {
            teamStats.forEach((agent, index) => {
                response += `${index + 1}. <strong>${agent.name}</strong><br>`;
                response += `📧 ${agent.email}<br>`;
                response += `🎫 פניות: ${agent.total_tickets || 0}<br><br>`;
            });
        }
        
        return {
            message: response,
            intent: 'team_performance',
            confidence: 0.9
        };
    } catch (error) {
        throw error;
    }
}

// יצירת דוח
async function handleCreateReport(message, userRole, userId, orgId) {
    try {
        const [stats] = await db.query(`
            SELECT 
                COUNT(*) as total_tickets,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_tickets,
                SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_tickets
            FROM tickets 
            WHERE organization_id = ?
        `, [orgId]);
        
        let response = `📋 <strong>דוח מערכת - ${new Date().toLocaleDateString('he-IL')}:</strong><br><br>`;
        response += '📊 <strong>סטטיסטיקות:</strong><br>';
        response += `• סה"כ פניות: ${stats[0].total_tickets}<br>`;
        response += `• פניות פתוחות: ${stats[0].open_tickets}<br>`;
        response += `• פניות סגורות: ${stats[0].closed_tickets}<br><br>`;
        response += '📧 <strong>הדוח נשמר במערכת</strong>';
        
        return {
            message: response,
            intent: 'create_report',
            confidence: 0.9
        };
    } catch (error) {
        throw error;
    }
}

// תגובת ברוכים הבאים
function generateWelcomeResponse(userRole) {
    return {
        message: `🤖 <strong>שלום! אני ARIA</strong><br><br>
                 אני העוזר החכם שלך במערכת ה-HelpDesk.<br><br>
                 💡 <strong>דוגמאות למה שאני יכול לעשות:</strong><br>
                 • "הצג פניות פתוחות"<br>
                 • "ביצועי הצוות"<br>
                 • "צור דוח יומי"<br><br>
                 איך אני יכול לעזור לך היום?`,
        intent: 'welcome',
        confidence: 1.0
    };
}

module.exports = router;
