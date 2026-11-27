CREATE TABLE IF NOT EXISTS app_config (
    config_key VARCHAR(64) NOT NULL PRIMARY KEY,
    config_value TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS card_assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    card_number VARCHAR(32) NOT NULL,
    card_expiry VARCHAR(16) NOT NULL DEFAULT '',
    card_cvc VARCHAR(16) NOT NULL DEFAULT '',
    card_holder VARCHAR(128) NOT NULL DEFAULT '' COMMENT '持卡人姓名',
    usage_count INT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    status VARCHAR(32) NOT NULL DEFAULT '正常',
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    last_used_at TIMESTAMP NULL DEFAULT NULL COMMENT '最后使用时间',
    daily_usage_count INT NOT NULL DEFAULT 0 COMMENT '24h 内使用次数',
    daily_usage_reset_at TIMESTAMP NULL DEFAULT NULL COMMENT '24h 计数重置时间',
    cooldown_until TIMESTAMP NULL DEFAULT NULL COMMENT '冷却截止时间',
    payment_holder_name VARCHAR(128) NOT NULL DEFAULT '',
    payment_address_line1 VARCHAR(200) NOT NULL DEFAULT '',
    payment_address_city VARCHAR(100) NOT NULL DEFAULT '',
    payment_address_state VARCHAR(100) NOT NULL DEFAULT '',
    payment_address_postal VARCHAR(20) NOT NULL DEFAULT '',
    payment_address_id BIGINT UNSIGNED NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_card_assets_sort (sort_order, id),
    KEY idx_card_assets_pick (is_active, in_use, locked_at, usage_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orbitcard_card_usage (
    card_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    usage_count INT NOT NULL DEFAULT 0,
    plan_type VARCHAR(32) NULL DEFAULT NULL,
    max_usage_count INT NOT NULL DEFAULT 1,
    initial_amount DECIMAL(12,2) NULL DEFAULT NULL,
    provider_balance DECIMAL(12,2) NULL DEFAULT NULL,
    provider_balance_currency VARCHAR(8) NULL DEFAULT NULL,
    provider_status VARCHAR(32) NULL DEFAULT NULL,
    provider_balance_updated_at TIMESTAMP NULL DEFAULT NULL,
    card_number VARCHAR(32) NULL DEFAULT NULL,
    card_expiry VARCHAR(16) NULL DEFAULT NULL,
    card_cvc VARCHAR(16) NULL DEFAULT NULL,
    card_holder VARCHAR(255) NULL DEFAULT NULL,
    product_code VARCHAR(128) NULL DEFAULT NULL,
    card_last4 VARCHAR(4) NULL DEFAULT NULL,
    daily_usage_count INT NOT NULL DEFAULT 0,
    daily_usage_reset_at TIMESTAMP NULL DEFAULT NULL,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    in_use TINYINT(1) NOT NULL DEFAULT 0,
    locked_at TIMESTAMP NULL DEFAULT NULL,
    locked_by VARCHAR(64) NULL DEFAULT NULL,
    last_used_at TIMESTAMP NULL DEFAULT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_orbitcard_usage_pick (status, in_use, cooldown_until, usage_count, last_used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orbitcard_card_recharges (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    card_id BIGINT UNSIGNED NOT NULL,
    job_key VARCHAR(128) NOT NULL,
    plan_type VARCHAR(32) NOT NULL DEFAULT 'plus',
    card_last4 VARCHAR(4) NOT NULL DEFAULT '',
    account_email VARCHAR(255) NOT NULL DEFAULT '',
    use_number INT NOT NULL DEFAULT 1,
    max_usage_count INT NOT NULL DEFAULT 1,
    initial_amount DECIMAL(12,2) NULL DEFAULT NULL,
    order_id VARCHAR(128) NULL DEFAULT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'running',
    message VARCHAR(255) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_orbitcard_recharge_job (job_key),
    KEY idx_orbitcard_recharge_card (card_id, created_at),
    KEY idx_orbitcard_recharge_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cdk_codes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cdk_code VARCHAR(32) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    shipped_at TIMESTAMP NULL DEFAULT NULL,
    used_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    type VARCHAR(16) NOT NULL DEFAULT '自助',
    plan_type VARCHAR(16) NOT NULL DEFAULT 'plus' COMMENT 'plus/pro100/pro200/pro500；兼容读取 pro_5x/pro_20x',
    fail_count INT DEFAULT 0,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    UNIQUE KEY uniq_cdk_codes_code (cdk_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS task_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    job_key VARCHAR(64) NOT NULL,
    token_preview VARCHAR(64) NOT NULL,
    session_payload MEDIUMTEXT NULL,
    cdk_code VARCHAR(32) NULL,
    phone VARCHAR(32) NULL,
    card_last4 VARCHAR(4) NULL,
    status VARCHAR(32) NOT NULL,
    message VARCHAR(255) NULL,
    progress INT NOT NULL DEFAULT 0,
    display_time VARCHAR(64) NOT NULL,
    raw_output MEDIUMTEXT NULL,
    failure_screenshots TEXT NULL,
    gpt_api_order_id VARCHAR(128) NULL DEFAULT NULL,
    gpt_api_task_id VARCHAR(128) NULL DEFAULT NULL,
    gpt_api_raw MEDIUMTEXT NULL,
    gpt_api_topup_code VARCHAR(255) NULL DEFAULT NULL,
    gpt_api_captcha MEDIUMTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_task_logs_job_key (job_key),
    KEY idx_task_logs_created (created_at),
    KEY idx_task_logs_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activation_attempt_limits (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    scope_type VARCHAR(16) NOT NULL,
    scope_key VARCHAR(128) NOT NULL,
    fail_count INT NOT NULL DEFAULT 0,
    cooldown_until TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_activation_attempt_scope (scope_type, scope_key),
    KEY idx_activation_attempt_cooldown (cooldown_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS activation_manual_holds (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_key VARCHAR(255) NOT NULL,
    account_email VARCHAR(255) NOT NULL DEFAULT '',
    plan_type VARCHAR(16) NOT NULL DEFAULT 'plus',
    failed_job_key VARCHAR(64) NULL DEFAULT NULL,
    cdk_code VARCHAR(32) NULL DEFAULT NULL,
    reason VARCHAR(512) NOT NULL DEFAULT '',
    resolved_at TIMESTAMP NULL DEFAULT NULL,
    resolved_by VARCHAR(128) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_activation_manual_hold_lookup (account_key, plan_type, resolved_at),
    KEY idx_activation_manual_hold_cdk (cdk_code, resolved_at),
    KEY idx_activation_manual_hold_status (resolved_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_login_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event VARCHAR(32) NOT NULL COMMENT 'login_success/login_failed/2fa_failed/secondary_failed/secondary_success/password_changed/logout',
    admin_email VARCHAR(128) NULL DEFAULT NULL,
    ip VARCHAR(45) NULL DEFAULT NULL,
    user_agent VARCHAR(512) NULL DEFAULT NULL,
    fingerprint VARCHAR(128) NULL DEFAULT NULL,
    detail VARCHAR(512) NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_admin_login_created (created_at),
    KEY idx_admin_login_event (event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ip_bans (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cidr VARCHAR(64) NOT NULL,
    reason VARCHAR(255) NOT NULL DEFAULT '',
    source VARCHAR(16) NOT NULL DEFAULT 'manual' COMMENT 'manual/auto',
    hits BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_hit_at TIMESTAMP NULL DEFAULT NULL,
    expires_at TIMESTAMP NULL DEFAULT NULL COMMENT 'NULL = 永久',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_ip_bans_cidr (cidr),
    KEY idx_ip_bans_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
