-- הוספות לסכמת מסד הנתונים עבור ARIA

-- יצירת טבלה לשיחות AI (אם לא קיימת)
CREATE TABLE IF NOT EXISTS ai_conversations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    message TEXT NOT NULL,
    message_type ENUM('user', 'aria') NOT NULL,
    response_to TEXT,
    context JSON,
    intent VARCHAR(100),
    confidence_score DECIMAL(3,2) DEFAULT 0.00,
    processing_time_ms INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_created (user_id, created_at),
    INDEX idx_intent (intent),
    INDEX idx_message_type (message_type)
);

-- טבלה לשמירת הגדרות ARIA לכל ארגון
CREATE TABLE IF NOT EXISTS aria_settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    organization_id INT NOT NULL,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    UNIQUE KEY unique_org_setting (organization_id, setting_key)
);

-- טבלה לשמירת תגובות מותאמות אישית של ARIA
CREATE TABLE IF NOT EXISTS aria_custom_responses (
    id INT PRIMARY KEY AUTO_INCREMENT,
    organization_id INT NOT NULL,
    trigger_phrase VARCHAR(255) NOT NULL,
    response_text TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    usage_count INT DEFAULT 0,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_org_trigger (organization_id, trigger_phrase),
    INDEX idx_active (is_active)
);

-- טבלה לשמירת דוחות שנוצרו על ידי ARIA
CREATE TABLE IF NOT EXISTS aria_reports (
    id INT PRIMARY KEY AUTO_INCREMENT,
    organization_id INT NOT NULL,
    report_type VARCHAR(50) NOT NULL,
    report_title VARCHAR(255) NOT NULL,
    report_data JSON,
    report_summary TEXT,
    generated_by INT NOT NULL,
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_org_type (organization_id, report_type),
    INDEX idx_generated_at (generated_at)
);

-- טבלה למעקב אחרי פעולות ARIA
CREATE TABLE IF NOT EXISTS aria_actions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    organization_id INT NOT NULL,
    user_id INT NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    action_description TEXT,
    target_type VARCHAR(50),
    target_id INT,
    result_status VARCHAR(20) DEFAULT 'pending',
    result_data JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_org_user (organization_id, user_id),
    INDEX idx_action_type (action_type),
    INDEX idx_status (result_status)
);

-- טבלה לשמירת insights ותובנות של ARIA
CREATE TABLE IF NOT EXISTS aria_insights (
    id INT PRIMARY KEY AUTO_INCREMENT,
    organization_id INT NOT NULL,
    insight_type VARCHAR(50) NOT NULL,
    insight_title VARCHAR(255) NOT NULL,
    insight_description TEXT,
    insight_data JSON,
    priority_level ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
    is_read BOOLEAN DEFAULT FALSE,
    is_actionable BOOLEAN DEFAULT FALSE,
    action_taken BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    INDEX idx_org_priority (organization_id, priority_level),
    INDEX idx_unread (is_read),
    INDEX idx_actionable (is_actionable)
);

-- הוספת שדות לטבלת users עבור מעקב פעילות ARIA
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS last_aria_interaction TIMESTAMP NULL,
ADD COLUMN IF NOT EXISTS aria_queries_count INT DEFAULT 0;

-- הוספת indexes חדשים לטבלת users
ALTER TABLE users 
ADD INDEX IF NOT EXISTS idx_last_aria_interaction (last_aria_interaction);

-- טבלה לשמירת feedback על תגובות ARIA
CREATE TABLE IF NOT EXISTS aria_feedback (
    id INT PRIMARY KEY AUTO_INCREMENT,
    conversation_id INT NOT NULL,
    user_id INT NOT NULL,
    rating TINYINT CHECK (rating BETWEEN 1 AND 5),
    feedback_text TEXT,
    is_helpful BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_conversation (conversation_id),
    INDEX idx_rating (rating)
);

-- הוספת נתוני ברירת מחדל עבור ARIA
INSERT IGNORE INTO aria_settings (organization_id, setting_key, setting_value) 
SELECT id, 'aria_enabled', 'true' FROM organizations;

INSERT IGNORE INTO aria_settings (organization_id, setting_key, setting_value) 
SELECT id, 'aria_auto_categorize', 'true' FROM organizations;

INSERT IGNORE INTO aria_settings (organization_id, setting_key, setting_value) 
SELECT id, 'aria_response_delay', '1500' FROM organizations;

-- הוספת insights בסיסיים
INSERT IGNORE INTO aria_insights (organization_id, insight_type, insight_title, insight_description, priority_level, is_actionable) 
SELECT 
    id, 
    'welcome', 
    'ברוכים הבאים ל-ARIA!', 
    'ARIA מוכן לעבודה. המערכת מנתחת את הנתונים שלך ותציע תובנות וייעוץ מותאם אישית.', 
    'medium', 
    FALSE 
FROM organizations;

-- יצירת view לסטטיסטיקות ARIA
CREATE OR REPLACE VIEW aria_stats AS
SELECT 
    o.id as organization_id,
    o.name as organization_name,
    COUNT(DISTINCT ac.id) as total_conversations,
    COUNT(DISTINCT CASE WHEN DATE(ac.created_at) = CURDATE() THEN ac.id END) as conversations_today,
    COUNT(DISTINCT ac.user_id) as unique_users,
    AVG(ac.processing_time_ms) as avg_processing_time,
    COUNT(DISTINCT af.id) as total_feedback,
    AVG(af.rating) as avg_rating
FROM organizations o
LEFT JOIN ai_conversations ac ON o.id = (SELECT organization_id FROM users WHERE id = ac.user_id LIMIT 1)
LEFT JOIN aria_feedback af ON ac.id = af.conversation_id
GROUP BY o.id, o.name;

-- יצירת view לדשבורד מנהלים
CREATE OR REPLACE VIEW manager_dashboard AS
SELECT 
    o.id as organization_id,
    o.name as organization_name,
    COUNT(DISTINCT t.id) as total_tickets,
    COUNT(DISTINCT CASE WHEN t.status = 'open' THEN t.id END) as open_tickets,
    COUNT(DISTINCT CASE WHEN DATE(t.created_at) = CURDATE() THEN t.id END) as tickets_today,
    COUNT(DISTINCT u.id) as total_agents,
    COUNT(DISTINCT CASE WHEN u.last_active > DATE_SUB(NOW(), INTERVAL 1 HOUR) THEN u.id END) as active_agents,
    COUNT(DISTINCT ac.id) as aria_conversations,
    AVG(CASE WHEN t.status = 'closed' THEN 
        TIMESTAMPDIFF(MINUTE, t.created_at, t.updated_at) 
    END) as avg_resolution_minutes
FROM organizations o
LEFT JOIN tickets t ON o.id = t.organization_id
LEFT JOIN users u ON o.id = u.organization_id AND u.role IN ('agent', 'manager')
LEFT JOIN ai_conversations ac ON u.id = ac.user_id
GROUP BY o.id, o.name;
