const { isDevelopEnv } = require('./customer');

const STORAGE_KEY = 'miniapp.staffOpenId';
const DEFAULT_DEVELOP_STAFF_OPENID = 'staff-openid-demo';

function createMockStaffOpenId() {
  return DEFAULT_DEVELOP_STAFF_OPENID;
}

function buildIdentity(openId) {
  const nextOpenId = (openId || '').trim();
  if (!nextOpenId) {
    return {
      openId: '',
      source: 'missing',
      isMock: false,
      canUse: false,
      label: '未设置店员 OpenID'
    };
  }

  const isMock = nextOpenId === DEFAULT_DEVELOP_STAFF_OPENID || nextOpenId.indexOf('mock-staff-openid-') === 0;
  return {
    openId: nextOpenId,
    source: isMock ? 'mock' : 'real',
    isMock,
    canUse: true,
    label: isMock ? '开发环境模拟店员 OpenID' : '店员 OpenID'
  };
}

function ensureStaffIdentity() {
  const stored = wx.getStorageSync(STORAGE_KEY);
  return buildIdentity(stored);
}

function setStaffOpenId(openId) {
  const nextOpenId = (openId || '').trim();
  if (nextOpenId) {
    wx.setStorageSync(STORAGE_KEY, nextOpenId);
    return buildIdentity(nextOpenId);
  }

  wx.removeStorageSync(STORAGE_KEY);
  return buildIdentity('');
}

function clearStaffOpenId() {
  wx.removeStorageSync(STORAGE_KEY);
  return buildIdentity('');
}

function getStaffIdentityOrThrow() {
  const identity = ensureStaffIdentity();
  if (identity.canUse) {
    return identity;
  }

  const error = new Error(
    isDevelopEnv()
      ? '未获取到店员 OpenID。开发环境请先在店员页手动设置模拟 OpenID。'
      : '未获取到店员 OpenID，请使用店员身份重新进入后重试。'
  );
  error.code = 'STAFF_OPENID_MISSING';
  error.statusCode = 401;
  error.isUnauthorized = true;
  throw error;
}

module.exports = {
  STORAGE_KEY,
  DEFAULT_DEVELOP_STAFF_OPENID,
  createMockStaffOpenId,
  ensureStaffIdentity,
  setStaffOpenId,
  clearStaffOpenId,
  getStaffIdentityOrThrow
};
