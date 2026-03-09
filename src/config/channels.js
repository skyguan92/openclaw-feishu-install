const FEISHU_PHASES = [
  'login',
  'create_app',
  'credentials',
  'bot',
  'permissions',
  'configure_openclaw',
  'restart_gateway',
  'events',
  'publish',
  'post_publish_message',
];

const FEISHU_PHASE_LABELS = {
  login: '登录飞书',
  create_app: '创建应用',
  credentials: '获取凭证',
  bot: '启用机器人',
  permissions: '配置权限',
  configure_openclaw: '配置 OpenClaw',
  restart_gateway: '重启 Gateway',
  events: '事件订阅',
  publish: '发布应用',
  post_publish_message: '发送首条消息',
};

const WECOM_PHASES = [
  'login',
  'create_bot',
  'configure_openclaw',
  'restart_gateway',
];

const WECOM_PHASE_LABELS = {
  login: '登录企业微信',
  create_bot: '创建机器人',
  configure_openclaw: '配置企业微信',
  restart_gateway: '重启 Gateway',
};

const CHANNEL_SPECS = {
  feishu: {
    id: 'feishu',
    label: '飞书',
    phases: FEISHU_PHASES,
    phaseLabels: FEISHU_PHASE_LABELS,
    browserPhases: [
      'login',
      'create_app',
      'credentials',
      'bot',
      'permissions',
      'events',
      'publish',
      'post_publish_message',
    ],
    completionMessage: '所有步骤已完成！飞书机器人已配置、发布，并已主动给当前操作者发送首条消息。',
  },
  wecom: {
    id: 'wecom',
    label: '企业微信',
    phases: WECOM_PHASES,
    phaseLabels: WECOM_PHASE_LABELS,
    browserPhases: [
      'login',
      'create_bot',
    ],
    completionMessage: '企业微信机器人已创建并接入 OpenClaw，Gateway 已完成重启并建立长连接。',
  },
};

const DEFAULT_CHANNEL = 'feishu';

function normalizeChannel(channel, fallback = DEFAULT_CHANNEL) {
  if (!channel) {
    return fallback;
  }

  if (!Object.prototype.hasOwnProperty.call(CHANNEL_SPECS, channel)) {
    throw new Error(`不支持的渠道: ${channel}`);
  }

  return channel;
}

function getChannelSpec(channel) {
  return CHANNEL_SPECS[normalizeChannel(channel)];
}

module.exports = {
  CHANNEL_SPECS,
  DEFAULT_CHANNEL,
  getChannelSpec,
  normalizeChannel,
};
