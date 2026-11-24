/**
 * MySQL 连接与建表。时间一律存 unix 秒（BIGINT），和归档服务、原评分系统保持一致。
 */
import mysql, { ResultSetHeader } from 'mysql2/promise'
import { config } from './config'

export const pool = mysql.createPool({
  ...config.mysql,
  charset: 'utf8mb4',
  timezone: '+08:00',
  connectionLimit: 10,
  waitForConnections: true
})

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params)
  return rows as T[]
}

export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await pool.query(sql, params)
  return res as ResultSetHeader
}

export const now = (): number => Math.floor(Date.now() / 1000)

/** 幂等建表：启动时执行，重复执行无副作用。后续功能搬迁时在这里追加表 */
const SCHEMA: string[] = [
  // 部门：客服部 / 技术支持部，各自的考核规则模板与功能开关
  `CREATE TABLE IF NOT EXISTS departments (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code          VARCHAR(32)  NOT NULL,
    name          VARCHAR(64)  NOT NULL,
    kpi_template  VARCHAR(16)  NOT NULL,          -- cs = 客服部五项规则；tech = 技术支持部两项 + 主管评分
    group_chat    TINYINT      NOT NULL DEFAULT 0, -- 是否启用对公群数据源
    sort          INT          NOT NULL DEFAULT 0,
    created_at    BIGINT       NOT NULL,
    UNIQUE KEY uk_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 登录账号：admin = 总管理员（看全部部门）；manager = 部门主管（只看自己部门）
  `CREATE TABLE IF NOT EXISTS accounts (
    id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username              VARCHAR(64)  NOT NULL,
    display_name          VARCHAR(64)  NOT NULL,
    role                  VARCHAR(16)  NOT NULL,
    department_id         INT UNSIGNED NULL,
    password_hash         VARCHAR(100) NOT NULL,
    must_change_password  TINYINT      NOT NULL DEFAULT 1,
    disabled              TINYINT      NOT NULL DEFAULT 0,
    created_at            BIGINT       NOT NULL,
    last_login_at         BIGINT       NOT NULL DEFAULT 0,
    UNIQUE KEY uk_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 登录会话：只存 token 的哈希，数据库泄露也拿不到可用的登录凭证
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash  CHAR(64)     NOT NULL PRIMARY KEY,
    account_id  INT UNSIGNED NOT NULL,
    created_at  BIGINT       NOT NULL,
    expires_at  BIGINT       NOT NULL,
    ip          VARCHAR(64)  NOT NULL DEFAULT '',
    KEY idx_account (account_id),
    KEY idx_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // 系统设置（键值，值为 JSON）：SaleSmartly、AI 接口、归档服务地址等
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\`       VARCHAR(64) NOT NULL PRIMARY KEY,
    value       JSON        NOT NULL,
    updated_at  BIGINT      NOT NULL,
    updated_by  VARCHAR(64) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // 操作日志：谁在什么时候改了什么，考核有争议时可查
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    account_id     INT UNSIGNED NULL,
    username       VARCHAR(64)  NOT NULL DEFAULT '',
    department_id  INT UNSIGNED NULL,
    action         VARCHAR(64)  NOT NULL,
    target         VARCHAR(255) NOT NULL DEFAULT '',
    detail         JSON         NULL,
    ip             VARCHAR(64)  NOT NULL DEFAULT '',
    created_at     BIGINT       NOT NULL,
    KEY idx_created (created_at),
    KEY idx_action (action, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]

export async function ensureSchema(): Promise<void> {
  for (const sql of SCHEMA) await execute(sql)
}
