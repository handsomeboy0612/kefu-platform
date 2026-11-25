/**
 * MySQL 连接与建表。时间一律存 unix 秒（BIGINT），和归档服务、原评分系统保持一致。
 */
import mysql, { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import { config } from './config'

export const pool = mysql.createPool({
  ...config.mysql,
  charset: 'utf8mb4',
  timezone: '+08:00',
  connectionLimit: 10,
  waitForConnections: true
})

// 每个连接都用北京时间：FROM_UNIXTIME / DATE 这类按天拆分的都在数据库里算，
// 不能依赖 MySQL 服务自己的时区（这台机器的 MySQL 启动时还是美东时间，按天统计会差 13 小时）
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+08:00'")
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

/**
 * 在一个事务里执行，出错自动回滚。
 * readCommitted：用读已提交隔离级别（DELETE 不加间隙锁，并发整段替换同一张表时不容易死锁）
 */
export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>, opts: { readCommitted?: boolean } = {}): Promise<T> {
  const conn = await pool.getConnection()
  try {
    if (opts.readCommitted) await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await conn.beginTransaction()
    const r = await fn(conn)
    await conn.commit()
    return r
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 客服成员：从 SaleSmartly 项目拉下来，按 (项目, sys_user_id) 唯一。
  // 一个人只属于一个部门；班次 NULL = 按 SaleSmartly 分组名自动判断；active=0 = 已不在项目里（离职 / 移出）
  `CREATE TABLE IF NOT EXISTS members (
    id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id     VARCHAR(64)  NOT NULL,
    sys_user_id    BIGINT       NOT NULL,
    nickname       VARCHAR(128) NOT NULL DEFAULT '',
    email          VARCHAR(128) NOT NULL DEFAULT '',
    group_names    VARCHAR(512) NOT NULL DEFAULT '',
    department_id  INT UNSIGNED NULL,
    shift          VARCHAR(16)  NULL,
    participate    TINYINT      NOT NULL DEFAULT 1,
    active         TINYINT      NOT NULL DEFAULT 1,
    first_seen_at  BIGINT       NOT NULL,
    last_seen_at   BIGINT       NOT NULL,
    updated_at     BIGINT       NOT NULL DEFAULT 0,
    updated_by     VARCHAR(64)  NOT NULL DEFAULT '',
    UNIQUE KEY uk_member (project_id, sys_user_id),
    KEY idx_dept (department_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // SaleSmartly 会话（按项目存一份，部门按负责客服所在部门看）
  `CREATE TABLE IF NOT EXISTS ss_sessions (
    project_id      VARCHAR(64)  NOT NULL,
    session_id      VARCHAR(64)  NOT NULL,
    chat_user_id    VARCHAR(128) NOT NULL DEFAULT '',
    customer_name   VARCHAR(255) NOT NULL DEFAULT '',
    sys_user_id     BIGINT       NOT NULL DEFAULT 0,
    channel         INT          NOT NULL DEFAULT 0,
    channel_id      BIGINT       NOT NULL DEFAULT 0,
    start_time      BIGINT       NOT NULL,
    end_time        BIGINT       NOT NULL DEFAULT 0,
    assign_time     BIGINT       NOT NULL DEFAULT 0,
    star_score      TINYINT      NOT NULL DEFAULT 0,
    quality_score   INT          NOT NULL DEFAULT 0,
    tags            TEXT         NULL,
    msg_count       INT          NOT NULL DEFAULT 0,
    user_msg_count  INT          NOT NULL DEFAULT 0,
    kf_msg_count    INT          NOT NULL DEFAULT 0,
    msgs_synced     TINYINT      NOT NULL DEFAULT 0,  -- 聊天记录是否已拉到本地
    msg_fail        TINYINT      NOT NULL DEFAULT 0,  -- 聊天记录连续拉取失败次数，到 3 次不再自动重试
    synced_at       BIGINT       NOT NULL,
    PRIMARY KEY (project_id, session_id),
    KEY idx_start (project_id, start_time),
    KEY idx_member (project_id, sys_user_id, start_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 会话聊天记录（已整理成客户 / 客服 / 机器人 / 系统四类，内部事件已去掉）
  `CREATE TABLE IF NOT EXISTS ss_messages (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id   VARCHAR(64)   NOT NULL,
    session_id   VARCHAR(64)   NOT NULL,
    mid          VARCHAR(64)   NOT NULL DEFAULT '',
    sender_type  VARCHAR(10)   NOT NULL,
    sender_name  VARCHAR(128)  NOT NULL DEFAULT '',
    content      MEDIUMTEXT    NOT NULL,
    msg_type     INT           NOT NULL DEFAULT 0,
    send_time    BIGINT        NOT NULL,
    image_url    VARCHAR(1024) NOT NULL DEFAULT '',
    recalled     TINYINT       NOT NULL DEFAULT 0,
    KEY idx_session (project_id, session_id, send_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 每次同步的记录（自动 / 手动），数据状态里看
  `CREATE TABLE IF NOT EXISTS sync_runs (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id        VARCHAR(64)  NOT NULL,
    source            VARCHAR(16)  NOT NULL DEFAULT 'ss',
    \`trigger\`         VARCHAR(16)  NOT NULL,          -- auto / manual
    triggered_by      VARCHAR(64)  NOT NULL DEFAULT '',
    range_begin       BIGINT       NOT NULL,
    range_end         BIGINT       NOT NULL,
    status            VARCHAR(16)  NOT NULL,          -- running / success / failed
    started_at        BIGINT       NOT NULL,
    finished_at       BIGINT       NOT NULL DEFAULT 0,
    sessions_fetched  INT          NOT NULL DEFAULT 0,
    sessions_new      INT          NOT NULL DEFAULT 0,
    messages_synced   INT          NOT NULL DEFAULT 0,
    messages_failed   INT          NOT NULL DEFAULT 0,
    error             TEXT         NULL,
    KEY idx_project (project_id, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // AI 质检结果：每个会话一条（重评覆盖）。status=failed 表示从来没评成功过，error 里是原因
  `CREATE TABLE IF NOT EXISTS ai_scores (
    project_id     VARCHAR(64)   NOT NULL,
    session_id     VARCHAR(64)   NOT NULL,
    department_id  INT UNSIGNED  NOT NULL,
    status         VARCHAR(8)    NOT NULL,
    total_score    DECIMAL(4,1)  NULL,
    grade          VARCHAR(8)    NOT NULL DEFAULT '',
    dimensions     JSON          NULL,   -- [{name, weight, score}]
    highlights     JSON          NULL,
    issues         JSON          NULL,
    summary        TEXT          NULL,
    improvement    TEXT          NULL,
    raw            JSON          NULL,   -- AI 原始输出（提示词要求的其他字段都在这里）
    error          TEXT          NULL,
    model          VARCHAR(64)   NOT NULL DEFAULT '',
    prompt_hash    CHAR(12)      NOT NULL DEFAULT '',
    tokens_in      INT           NOT NULL DEFAULT 0,
    tokens_out     INT           NOT NULL DEFAULT 0,
    scored_by      VARCHAR(64)   NOT NULL DEFAULT '',  -- 账号名；自动评分是 auto
    scored_at      BIGINT        NOT NULL,
    reviewed       TINYINT       NOT NULL DEFAULT 0,   -- 主管人工复核过
    reviewed_by    VARCHAR(64)   NOT NULL DEFAULT '',
    reviewed_at    BIGINT        NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, session_id),
    KEY idx_dept (department_id, scored_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 群内员工挂靠：企业微信 user_id → SaleSmartly 成员（sys_user_id = 0 表示没挂上）
  `CREATE TABLE IF NOT EXISTS wg_staff (
    user_id      VARCHAR(128) NOT NULL PRIMARY KEY,
    nickname     VARCHAR(128) NOT NULL DEFAULT '',   -- 群昵称（如「技术支持部-蒋海军」），没有就用个人昵称
    raw_name     VARCHAR(128) NOT NULL DEFAULT '',   -- 消息里的个人昵称
    sys_user_id  BIGINT       NOT NULL DEFAULT 0,
    manual       TINYINT      NOT NULL DEFAULT 0,    -- 1 = 手动指定（自动匹配不覆盖）
    last_seen_at BIGINT       NOT NULL DEFAULT 0,
    updated_by   VARCHAR(64)  NOT NULL DEFAULT '',
    updated_at   BIGINT       NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 对公群原始消息（选中的群，同步时整批存下来），AI 分问题按消息编号引用
  `CREATE TABLE IF NOT EXISTS wg_messages (
    msg_id       VARCHAR(128) NOT NULL PRIMARY KEY,
    room_id      VARCHAR(128) NOT NULL,
    sender_id    VARCHAR(128) NOT NULL DEFAULT '',
    sender_name  VARCHAR(128) NOT NULL DEFAULT '',
    is_staff     TINYINT      NOT NULL DEFAULT 0,
    is_self      TINYINT      NOT NULL DEFAULT 0,
    msg_type     INT          NOT NULL DEFAULT 0,
    content      MEDIUMTEXT   NOT NULL,
    at_list      JSON         NULL,
    refer_id     VARCHAR(128) NOT NULL DEFAULT '',
    send_time    BIGINT       NOT NULL,
    KEY idx_room_time (room_id, send_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // AI 识别出的对公群问题（一个问题可以跨天，算在开始那天）
  `CREATE TABLE IF NOT EXISTS wg_issues (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id   INT UNSIGNED NOT NULL,
    room_id         VARCHAR(128) NOT NULL,
    room_name       VARCHAR(255) NOT NULL DEFAULT '',
    day             CHAR(10)     NOT NULL,             -- 问题开始那天（北京时间）
    updated_day     CHAR(10)     NOT NULL,             -- 最后一次被哪天的分析改过
    anchor_msg_id   VARCHAR(128) NOT NULL,             -- 问题的第一条消息（核对 / 修改按它对应，重跑后也能找回）
    summary         TEXT         NOT NULL,
    customer_ids    JSON         NOT NULL,
    message_ids     JSON         NOT NULL,
    handler_user_id VARCHAR(128) NOT NULL DEFAULT '',  -- 企微 user_id；空 = 没人处理
    handler_reason  TEXT         NULL,
    helper_ids      JSON         NULL,
    status          VARCHAR(12)  NOT NULL,             -- resolved / unresolved / unknown
    resolved_msg_id VARCHAR(128) NOT NULL DEFAULT '',
    evidence        TEXT         NULL,
    first_customer_at BIGINT     NOT NULL DEFAULT 0,
    first_reply_at  BIGINT       NOT NULL DEFAULT 0,   -- 处理人第一次回应（含「稍等」）
    resolved_at     BIGINT       NOT NULL DEFAULT 0,
    created_at      BIGINT       NOT NULL,
    KEY idx_dept_day (department_id, day),
    KEY idx_room_day (room_id, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 每个群每天的 AI 分析记录：缓存（输入没变不重调 AI）+ 回滚信息（重跑时撤回这一天的改动）
  `CREATE TABLE IF NOT EXISTS wg_issue_runs (
    department_id  INT UNSIGNED NOT NULL,
    room_id        VARCHAR(128) NOT NULL,
    day            CHAR(10)     NOT NULL,
    chain_hash     CHAR(64)     NOT NULL,     -- 这天的消息 + 之前各天的结果 + 提示词版本 + 模型
    out_hash       CHAR(64)     NOT NULL DEFAULT '',
    status         VARCHAR(8)   NOT NULL,     -- ok / failed
    error          TEXT         NULL,
    output         JSON         NULL,         -- 校验通过的 AI 输出
    applied        TINYINT      NOT NULL DEFAULT 0,
    created_issue_ids JSON      NULL,
    prev_states    JSON         NULL,         -- 这天改过的旧问题改之前的样子
    model          VARCHAR(64)  NOT NULL DEFAULT '',
    tokens_in      INT          NOT NULL DEFAULT 0,
    tokens_out     INT          NOT NULL DEFAULT 0,
    attempts       INT          NOT NULL DEFAULT 0,
    updated_at     BIGINT       NOT NULL,
    PRIMARY KEY (department_id, room_id, day)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 主管对问题的核对和修改（按群 + 问题第一条消息对应，AI 重跑也不会丢）
  `CREATE TABLE IF NOT EXISTS wg_issue_marks (
    department_id    INT UNSIGNED NOT NULL,
    room_id          VARCHAR(128) NOT NULL,
    anchor_msg_id    VARCHAR(128) NOT NULL,
    boundary_ok      TINYINT      NULL,      -- 问题边界对不对（1 对 / 0 不对 / NULL 没核对）
    handler_ok       TINYINT      NULL,
    status_ok        TINYINT      NULL,
    note             TEXT         NULL,
    override_handler VARCHAR(128) NULL,      -- 主管改的处理人（企微 user_id；空串 = 没人处理）
    override_status  VARCHAR(12)  NULL,
    updated_by       VARCHAR(64)  NOT NULL DEFAULT '',
    updated_at       BIGINT       NOT NULL,
    PRIMARY KEY (department_id, room_id, anchor_msg_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 绩效考核的人工剔除：reply = 回复率扣分剔除（复核后认为不该扣），bad_review = 差评申诉剔除
  `CREATE TABLE IF NOT EXISTS kpi_exemptions (
    project_id  VARCHAR(64)  NOT NULL,
    session_id  VARCHAR(64)  NOT NULL,
    kind        VARCHAR(16)  NOT NULL,
    created_by  VARCHAR(64)  NOT NULL DEFAULT '',
    created_at  BIGINT       NOT NULL,
    PRIMARY KEY (project_id, session_id, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 技术支持部每月人工录入：主管评分、投诉、扣分（按部门 + 月份 + 客服）
  `CREATE TABLE IF NOT EXISTS kpi_manual (
    department_id  INT UNSIGNED NOT NULL,
    month          CHAR(7)      NOT NULL,   -- YYYY-MM
    sys_user_id    BIGINT       NOT NULL,
    data           JSON         NOT NULL,
    updated_by     VARCHAR(64)  NOT NULL DEFAULT '',
    updated_at     BIGINT       NOT NULL,
    PRIMARY KEY (department_id, month, sys_user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 绩效快照：每次生成报表按「部门 + 时段」存一份（同一时段重新生成会覆盖），可回看历史
  `CREATE TABLE IF NOT EXISTS kpi_snapshots (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    department_id  INT UNSIGNED NOT NULL,
    range_begin    BIGINT       NOT NULL,
    range_end      BIGINT       NOT NULL,
    template       VARCHAR(8)   NOT NULL,
    rules          JSON         NOT NULL,
    results        JSON         NOT NULL,
    created_by     VARCHAR(64)  NOT NULL DEFAULT '',
    created_at     BIGINT       NOT NULL,
    UNIQUE KEY uk_range (department_id, range_begin, range_end)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
]

/** 给已有的表补列（MySQL 8 没有 ADD COLUMN IF NOT EXISTS） */
async function addColumn(table: string, column: string, ddl: string): Promise<void> {
  const [row] = await query<{ n: number }>(
    'SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, column]
  )
  if (!Number(row?.n)) await execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}

export async function ensureSchema(): Promise<void> {
  for (const sql of SCHEMA) await execute(sql)
  // 会话来源：ss = SaleSmartly，wg = 企业微信对公群（群消息切段后的「群会话」，渠道号 -2）
  await addColumn('ss_sessions', 'source', "source VARCHAR(8) NOT NULL DEFAULT 'ss' AFTER session_id")
  await addColumn('ss_sessions', 'room_id', "room_id VARCHAR(128) NOT NULL DEFAULT '' AFTER source")
  // 同步结果的补充信息（对公群的挂靠提醒、采集中断等）
  await addColumn('sync_runs', 'detail', 'detail JSON NULL')
  // 早期建的这几张表没写排序规则，用了 MySQL 默认的 utf8mb4_0900_ai_ci，和会话表 JOIN 会报排序规则冲突
  for (const t of ['kpi_exemptions', 'kpi_manual']) {
    const [row] = await query<{ c: string }>(
      'SELECT TABLE_COLLATION c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]
    )
    if (row && row.c !== 'utf8mb4_unicode_ci') await execute(`ALTER TABLE ${t} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  }
}
