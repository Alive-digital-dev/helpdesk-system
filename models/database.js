const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

class Database {
    constructor() {
        this.pool = null;
        this.isInitialized = false;
    }

    async initialize() {
        try {
            console.log('🔄 Initializing database...');
            
            // Create connection pool
            if (process.env.DATABASE_URL) {
                this.pool = mysql.createPool(process.env.DATABASE_URL);
            } else {
                this.pool = mysql.createPool({
                    host: process.env.DB_HOST || 'localhost',
                    user: process.env.DB_USER || 'root',
                    password: process.env.DB_PASSWORD || '',
                    database: process.env.DB_NAME || 'helpdesk'
                });
            }

            const connection = await this.pool.getConnection();
            
            // Create basic tables
            await this.createBasicTables(connection);
            await this.createDefaultData(connection);
            
            connection.release();
            this.isInitialized = true;
            console.log('✅ Database initialized successfully');
            
        } catch (error) {
            console.error('❌ Database initialization failed:', error);
            // Don't throw - let app continue
        }
    }

    async createBasicTables(connection) {
        const tables = [
            `CREATE TABLE IF NOT EXISTS organizations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                plan VARCHAR(50) DEFAULT 'free',
                status VARCHAR(50) DEFAULT 'active',
                monthly_ticket_limit INT DEFAULT 50,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`,

            `CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                organization_id INT,
                status VARCHAR(50) DEFAULT 'active',
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
                FOREIGN KEY (organization_id) REFERENCES organizations(id)
            )`,

            `CREATE TABLE IF NOT EXISTS tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_number VARCHAR(50) UNIQUE NOT NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                status VARCHAR(50) DEFAULT 'new',
                priority VARCHAR(50) DEFAULT 'medium',
                channel VARCHAR(50) NOT NULL,
                customer_id INT NOT NULL,
                organization_id INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers(id),
                FOREIGN KEY (organization_id) REFERENCES organizations(id)
            )`,

            `CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                sender_type VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id)
            )`
        ];

        for (const table of tables) {
            await connection.execute(table);
        }
        console.log('📋 Basic tables created');
    }

    async createDefaultData(connection) {
        try {
            // Create super admin
            const [existingAdmin] = await connection.execute(
                'SELECT id FROM users WHERE role = ?',
                ['super_admin']
            );

            if (existingAdmin.length === 0) {
                const hashedPassword = await bcrypt.hash('admin123', 10);
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
                    'INSERT INTO organizations (name, email, plan) VALUES (?, ?, ?)',
                    ['Demo Organization', 'demo@helpdesk.com', 'professional']
                );

                const demoOrgId = orgResult.insertId;

                // Create demo admin
                const hashedPassword = await bcrypt.hash('demo123', 10);
                await connection.execute(
                    'INSERT INTO users (email, password, full_name, role, organization_id) VALUES (?, ?, ?, ?, ?)',
                    ['admin@demo.com', hashedPassword, 'Demo Admin', 'org_admin', demoOrgId]
                );

                console.log('✅ Demo organization created');
            }
        } catch (error) {
            console.error('Warning: Could not create default data:', error.message);
        }
    }

    async getConnection() {
        if (!this.pool) {
            throw new Error('Database not initialized');
        }
        return this.pool.getConnection();
    }

    async query(sql, params = []) {
        if (!this.pool) {
            throw new Error('Database not initialized');
        }
        
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
