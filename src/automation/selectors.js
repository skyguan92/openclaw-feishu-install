// Centralized selectors for Feishu Open Platform UI.
// Based on real DOM exploration on 2026-03-07.
//
// KEY FINDING: Feishu dev console is a SPA. Sub-pages like permissions,
// events, etc. CANNOT be navigated to via direct URL — they redirect to
// /baseinfo. Must click sidebar links instead.

module.exports = {
  // URLs
  urls: {
    appList: 'https://open.feishu.cn/app',
    appBase: (appId) => `https://open.feishu.cn/app/${appId}`,
    // These work for initial navigation:
    credentials: (appId) => `https://open.feishu.cn/app/${appId}/baseinfo`,
    version: (appId) => `https://open.feishu.cn/app/${appId}/version`,
    // These DON'T work via URL (SPA routes, redirect to /baseinfo):
    // - /bot, /permission/scope/list, /event/config
    // Must use sidebar navigation instead.
  },

  // Sidebar links (click these to navigate within the app)
  sidebar: {
    credentials: '凭证与基础信息',
    members: '成员管理',
    addAbility: '添加应用能力',
    bot: '机器人',
    permissions: '权限管理',
    events: '事件与回调',
    security: '安全设置',
    version: '版本管理与发布',
  },

  // Login
  login: {
    loggedInUrlPattern: /open\.feishu\.cn\/app\/?$/,
    accountHints: ['邮箱', '手机号', '手机号码', '账号', 'email', 'phone'],
    passwordHints: ['密码', 'password'],
    nextButtons: ['下一步', '继续', '登录'],
  },

  // Create App Modal
  createApp: {
    createButton: '创建企业自建应用',
    // Modal input: the visible input with empty placeholder at index 4 in DOM
    // Modal textarea: first textarea (for description)
    confirmButton: '创建',   // exact button text
    cancelButton: '取消',
    appIdFromUrl: /\/app\/(cli_[a-zA-Z0-9]+)/,
  },

  // Credentials page
  // App ID is displayed as plain text next to "App ID" label
  // App Secret is masked (**...) with copy/show/refresh icons
  credentials: {
    appIdLabel: 'App ID',
    appSecretLabel: 'App Secret',
    // The eye icon (show) button is next to the secret, no text label
    // Copy buttons are icon-only too
  },

  // Bot page (already enabled on existing app)
  bot: {
    // If bot not enabled, need to click "添加应用能力" in sidebar then select 机器人
    sidebarLink: '机器人',
    addAbilityLink: '添加应用能力',
    deleteAbilityButton: '删除能力',
  },

  // Permissions
  permissions: {
    sidebarLink: '权限管理',
    importButton: '批量导入',
    grantButton: '开通权限',
    // Minimal scopes for a text-based OpenClaw Feishu bot:
    // - receive DM messages sent to the bot
    // - receive @bot messages in groups
    // - send replies as the app/bot identity
    // - resolve basic sender profile information
    //
    // Intentionally excluded by default:
    // - im:message.group_msg        (read every group message without @bot)
    // - im:message:readonly        (quoted/history fetch, merge-forward expansion)
    // - im:resource                (image/file/audio/video receive+send)
    // - im:chat / im:chat.members  (chat directory/tooling)
    // - cardkit:card:write         (streaming card output)
    importPayload: {
      scopes: {
        tenant: [
          'im:message',
          'im:message.group_at_msg:readonly',
          'im:message.p2p_msg:readonly',
          'im:message:send_as_bot',
          'contact:contact.base:readonly',
          'contact:contact:readonly_as_app',
          'contact:user.employee_id:readonly',
          'contact:user.base:readonly',
        ],
      },
    },
    requiredScopes: [
      'im:message',
      'im:message.group_at_msg:readonly',
      'im:message.p2p_msg:readonly',
      'im:message:send_as_bot',
      'contact:contact.base:readonly',
      'contact:contact:readonly_as_app',
      'contact:user.employee_id:readonly',
      'contact:user.base:readonly',
    ],
  },

  // Events subscription
  events: {
    sidebarLink: '事件与回调',
    targetEvent: 'im.message.receive_v1',
  },

  // Version / Publish
  publish: {
    sidebarLink: '版本管理与发布',
    createVersionButton: '创建版本',
  },
};
