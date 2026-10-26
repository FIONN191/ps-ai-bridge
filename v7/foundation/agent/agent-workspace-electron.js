'use strict';
// Agent 的权限档位。这一版只开放「只读」和「编辑预设」（30 分钟）；
// 「修改软件 / 管理员」会改动程序文件，自动更新会覆盖掉这些改动，也不好回滚，所以不开放。
const TIERS = ['read_only', 'preset_editor'];
const GRANT_MS = 30 * 60 * 1000;

async function setup() {
  let grant = null;
  const governance = {
    tierInfo() {
      if (grant && grant.expiresAt <= Date.now()) grant = null;
      const tier = grant ? grant.tier : 'read_only';
      return { ok: true, tier, name: tier, expiresAt: grant ? new Date(grant.expiresAt).toISOString() : null, available: TIERS };
    },
    grant(tier) {
      if (!TIERS.includes(tier) || tier === 'read_only') return { ok: false, error: 'AGENT_TIER_UNSUPPORTED' };
      grant = { tier, expiresAt: Date.now() + GRANT_MS };
      return { ok: true, tier, expiresAt: new Date(grant.expiresAt).toISOString() };
    },
    revoke() { grant = null; },
  };
  return { governance };
}

module.exports = { setup, TIERS };
