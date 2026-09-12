const PREFIX = 'timesync:';

function keyFor(key, shared) {
  return PREFIX + (shared ? 'shared:' : 'personal:') + key;
}

export const storage = {
  async get(key, shared = false) {
    const raw = localStorage.getItem(keyFor(key, shared));
    if (raw === null) {
      throw new Error('Key not found: ' + key);
    }
    return { key, value: raw, shared };
  },
  async set(key, value, shared = false) {
    localStorage.setItem(keyFor(key, shared), value);
    return { key, value, shared };
  },
  async delete(key, shared = false) {
    const existed = localStorage.getItem(keyFor(key, shared)) !== null;
    localStorage.removeItem(keyFor(key, shared));
    return { key, deleted: existed, shared };
  },
  async list(prefix = '', shared = false) {
    const full = keyFor(prefix, shared);
    const stripLen = PREFIX.length + (shared ? 'shared:'.length : 'personal:'.length);
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(full)) keys.push(k.slice(stripLen));
    }
    return { keys, prefix, shared };
  },
};

if (typeof window !== 'undefined') {
  window.storage = storage;
}
