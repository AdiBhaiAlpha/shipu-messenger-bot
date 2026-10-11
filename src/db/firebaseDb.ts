import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';
import { databaseConfig, initialAdminBot } from '../config/database';
import fs from 'fs';
import path from 'path';

/**
 * Firebase Realtime Database layer — the ONLY database in this project.
 * MongoDB and Supabase have been removed; every collection below lives under
 * FIREBASE_BOT_ROOT ("shipu-messsenger-bot") via the REST API (no extra deps).
 *
 * The exported *Model objects intentionally mirror the small subset of the
 * Mongoose API the codebase actually uses (find/findOne/findById/updateOne/
 * updateMany/deleteOne/deleteMany/create/insertMany/countDocuments/
 * findByIdAndUpdate/findByIdAndDelete + lean/sort/limit/skip/select chains),
 * so existing call sites keep working unchanged.
 */

function baseUrl(): string {
  return (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
}

function urlFor(collectionPath: string, key?: string): string {
  const clean = String(collectionPath || '').replace(/^\/+|\/+$/g, '');
  const suffix = key !== undefined ? `/${key}` : '';
  return `${baseUrl()}/${FIREBASE_BOT_ROOT}/${clean}${suffix}.json`;
}

async function rtdbRequest(url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) detail = String(parsed.error).slice(0, 200);
      } catch {}
      throw new Error(`RTDB HTTP ${res.status}: ${detail}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Firebase keys can't be empty or contain $ # [ ] / . */
export function sanitizeKey(key: any): string {
  const s = String(key ?? '');
  const clean = s.replace(/[$#[\]/.]/g, '_');
  return clean || '_empty';
}

function sanitizeDocKeys(node: any): any {
  if (Array.isArray(node)) return node.map(sanitizeDocKeys);
  if (node && typeof node === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      out[sanitizeKey(k)] = sanitizeDocKeys(v);
    }
    return out;
  }
  return node;
}

const ID_FIELDS = ['accountId', 'userID', 'threadID', 'key', 'name', 'id', 'uid', 'configId', 'sessionID', 'messageID', 'slotId', 'botId'];

function stringifyId(v: any): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') {
    if (typeof (v as any).$oid === 'string') return (v as any).$oid;
    if (typeof (v as any).toString === 'function') {
      const s = (v as any).toString();
      if (s && s !== '[object Object]') return s;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function docKey(doc: any): string {
  if (!doc || typeof doc !== 'object') return `_doc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  for (const f of ID_FIELDS) {
    if (doc[f] !== undefined && doc[f] !== null && String(doc[f]) !== '') {
      return sanitizeKey(stringifyId(doc[f]));
    }
  }
  const oid = stringifyId((doc as any)._id);
  if (oid) return sanitizeKey(oid);
  return `_doc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// ---------- query matching (same loose semantics as the old Mongo layer) ----------

function getPath(obj: any, dotted: string): any {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj: any, dotted: string, value: any): void {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function matchesCondition(value: any, cond: any): boolean {
  if (cond instanceof RegExp) {
    return cond.test(String(value ?? ''));
  }
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    if (cond.$regex !== undefined) {
      const flags = cond.$options || '';
      try {
        return new RegExp(cond.$regex, flags).test(String(value ?? ''));
      } catch {
        return false;
      }
    }
    if (cond.$in !== undefined) {
      const arr = Array.isArray(cond.$in) ? cond.$in : [cond.$in];
      return arr.some(v => String(v) === String(value));
    }
    if (cond.$gte !== undefined && !(Number(value) >= Number(cond.$gte))) return false;
    if (cond.$lte !== undefined && !(Number(value) <= Number(cond.$lte))) return false;
    if (cond.$gt !== undefined && !(Number(value) > Number(cond.$gt))) return false;
    if (cond.$lt !== undefined && !(Number(value) < Number(cond.$lt))) return false;
    if (cond.$ne !== undefined && String(value) === String(cond.$ne)) return false;
    if (cond.$exists !== undefined) {
      const exists = value !== undefined;
      if (Boolean(cond.$exists) !== exists) return false;
    }
    // Bare object without operators: strict-ish compare like before
    const opKeys = Object.keys(cond).filter(k => k.startsWith('$'));
    if (opKeys.length === 0) return String(value) === String(cond as any);
    return true;
  }
  return String(value) === String(cond);
}

export function matchesQuery(item: any, query: any): boolean {
  if (!query || (typeof query === 'object' && Object.keys(query).length === 0)) return true;
  if (typeof query !== 'object') return false;
  if (Array.isArray((query as any).$or)) {
    return (query as any).$or.some((sub: any) => matchesQuery(item, sub));
  }
  if (Array.isArray((query as any).$and)) {
    return (query as any).$and.every((sub: any) => matchesQuery(item, sub));
  }
  for (const key of Object.keys(query)) {
    if (key === '$or' || key === '$and') continue;
    if (!matchesCondition(getPath(item, key), (query as any)[key])) return false;
  }
  return true;
}

function applyUpdate(item: any, update: any, isInsert = false): any {
  if (!update) return item;
  const hasOps = update.$set || update.$inc || update.$setOnInsert || update.$push || update.$unset || update.$addToSet;
  if (hasOps) {
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) setPath(item, k, v);
    }
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        const cur = Number(getPath(item, k) || 0);
        setPath(item, k, cur + (v as number));
      }
    }
    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        const cur = getPath(item, k);
        if (!Array.isArray(cur)) setPath(item, k, []);
        const arr = getPath(item, k);
        if ((v as any) && typeof v === 'object' && Array.isArray((v as any).$each)) {
          arr.push(...(v as any).$each);
        } else {
          arr.push(v);
        }
      }
    }
    if (update.$addToSet) {
      for (const [k, v] of Object.entries(update.$addToSet)) {
        const cur = getPath(item, k);
        if (!Array.isArray(cur)) setPath(item, k, []);
        const arr = getPath(item, k);
        if (!arr.some((e: any) => String(e) === String(v))) arr.push(v);
      }
    }
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) {
        const parts = String(k).split('.');
        let cur = item;
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur?.[parts[i]];
          if (!cur) break;
        }
        if (cur) delete cur[parts[parts.length - 1]];
      }
    }
    if (isInsert && update.$setOnInsert) {
      for (const [k, v] of Object.entries(update.$setOnInsert)) {
        if (getPath(item, k) === undefined) setPath(item, k, v);
      }
    }
  } else {
    for (const [k, v] of Object.entries(update)) {
      if (!k.startsWith('$')) setPath(item, k, v);
    }
  }
  return item;
}

// ---------- collection cache (lazy load once, write-through) ----------

type DocMap = Map<string, any>;
const collectionCache = new Map<string, DocMap>();
const collectionLoaded = new Set<string>();
const collectionFailed = new Map<string, string>();

let dbConnected = false;
let dbError: string | null = null;

async function ensureCollection(collectionPath: string): Promise<DocMap> {
  const cached = collectionCache.get(collectionPath);
  if (cached && collectionLoaded.has(collectionPath)) return cached;
  const map: DocMap = cached || new Map();
  try {
    const data = await rtdbRequest(urlFor(collectionPath), { method: 'GET' });
    map.clear();
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        map.set(k, v);
      }
    }
    collectionCache.set(collectionPath, map);
    collectionLoaded.add(collectionPath);
    collectionFailed.delete(collectionPath);
    dbConnected = true;
    dbError = null;
  } catch (err: any) {
    dbConnected = false;
    dbError = err?.message || String(err);
    collectionFailed.set(collectionPath, dbError);
    if (!collectionCache.has(collectionPath)) collectionCache.set(collectionPath, map);
  }
  return collectionCache.get(collectionPath)!;
}

async function persistDoc(collectionPath: string, key: string, doc: any): Promise<void> {
  const clean = sanitizeDocKeys(doc);
  try {
    await rtdbRequest(urlFor(collectionPath, key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean)
    });
    dbConnected = true;
    dbError = null;
  } catch (err: any) {
    dbConnected = false;
    dbError = err?.message || String(err);
    throw err;
  }
}

async function deleteRemoteDoc(collectionPath: string, key: string): Promise<void> {
  try {
    await rtdbRequest(urlFor(collectionPath, key), { method: 'DELETE' });
    dbConnected = true;
    dbError = null;
  } catch (err: any) {
    dbConnected = false;
    dbError = err?.message || String(err);
    throw err;
  }
}

function clone<T>(v: T): T {
  if (v === undefined || v === null) return v;
  return JSON.parse(JSON.stringify(v));
}

function sortDocs(docs: any[], sortSpec: any): any[] {
  const entries = Object.entries(sortSpec || {});
  if (entries.length === 0) return docs;
  return docs.sort((a, b) => {
    for (const [field, dir] of entries) {
      const av = getPath(a, field);
      const bv = getPath(b, field);
      let cmp = 0;
      if (av === bv) cmp = 0;
      else if (av === undefined) cmp = -1;
      else if (bv === undefined) cmp = 1;
      else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av) < String(bv) ? -1 : 1;
      if (cmp !== 0) return (Number(dir) === -1 ? -1 : 1) * cmp;
    }
    return 0;
  });
}

// ---------- thenable query objects (PromiseLike + chain compatible) ----------

function attachSave(collectionPath: string, map: DocMap, key: string, doc: any): any {
  if (!doc || typeof doc !== 'object') return doc;
  Object.defineProperty(doc, 'save', {
    value: async () => {
      (doc as any).updatedAt = Date.now();
      map.set(key, doc);
      await persistDoc(collectionPath, key, doc);
      return doc;
    },
    enumerable: false,
    configurable: true,
    writable: true
  });
  return doc;
}

type Fulfilled<T, R> = ((value: T) => R | PromiseLike<R>) | null | undefined;
type Rejected<R> = ((reason: any) => R | PromiseLike<R>) | null | undefined;

class RtdbFindQuery implements PromiseLike<any[]> {
  private sortSpec: any = null;
  private limitN: number | null = null;
  private skipN = 0;
  constructor(private collectionPath: string, private query: any, private preloaded: any[] | null = null) {}
  lean() { return this; }
  select(_fields: any) { return this; }
  sort(by: any) { this.sortSpec = by; return this; }
  limit(n: number) { this.limitN = n; return this; }
  skip(n: number) { this.skipN = n; return this; }
  async run(): Promise<any[]> {
    if (this.preloaded !== null) {
      let pre = this.preloaded.map(clone);
      if (this.sortSpec) pre = sortDocs(pre, this.sortSpec);
      if (this.skipN) pre = pre.slice(this.skipN);
      if (this.limitN !== null && this.limitN !== undefined) pre = pre.slice(0, this.limitN);
      return pre;
    }
    const map = await ensureCollection(this.collectionPath);
    const entries = Array.from(map.entries()).filter(([, d]) => matchesQuery(d, this.query));
    let docs = entries.map(([key, doc]) => attachSave(this.collectionPath, map, key, clone(doc)));
    if (this.sortSpec) docs = sortDocs(docs, this.sortSpec);
    if (this.skipN) docs = docs.slice(this.skipN);
    if (this.limitN !== null && this.limitN !== undefined) docs = docs.slice(0, this.limitN);
    return docs;
  }
  exec(): Promise<any[]> { return this.run(); }
  then<TResult1 = any[], TResult2 = never>(
    onfulfilled?: Fulfilled<any[], TResult1>,
    onrejected?: Rejected<TResult2>
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled as any, onrejected as any);
  }
}

class RtdbFindOneQuery implements PromiseLike<any> {
  constructor(private collectionPath: string, private query: any, private preloaded: any = undefined) {}
  lean() { return this; }
  select(_fields: any) { return this; }
  sort(_by: any) { return this; }
  async run(): Promise<any> {
    if (this.preloaded !== undefined) return clone(this.preloaded);
    const map = await ensureCollection(this.collectionPath);
    for (const [key, doc] of map.entries()) {
      if (matchesQuery(doc, this.query)) return attachSave(this.collectionPath, map, key, clone(doc));
    }
    return null;
  }
  exec(): Promise<any> { return this.run(); }
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: Fulfilled<any, TResult1>,
    onrejected?: Rejected<TResult2>
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled as any, onrejected as any);
  }
}

class RtdbCountQuery implements PromiseLike<number> {
  constructor(private collectionPath: string, private query: any, private preloaded: number | null = null) {}
  async run(): Promise<number> {
    if (this.preloaded !== null) return this.preloaded;
    const map = await ensureCollection(this.collectionPath);
    let n = 0;
    for (const doc of map.values()) {
      if (matchesQuery(doc, this.query)) n++;
    }
    return n;
  }
  exec(): Promise<number> { return this.run(); }
  then<TResult1 = number, TResult2 = never>(
    onfulfilled?: Fulfilled<number, TResult1>,
    onrejected?: Rejected<TResult2>
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled as any, onrejected as any);
  }
}

function idQuery(id: any): any {
  if (id && typeof id === 'object') return id;
  const str = stringifyId(id);
  return { $or: [{ _fid: str }, { _id: str }, { id: str }, { userID: str }, { accountId: str }] };
}

// ---------- model factory ----------

export interface FirebaseModel {
  collectionPath: string;
  find(query?: any): RtdbFindQuery;
  findOne(query?: any): RtdbFindOneQuery;
  findById(id: any): RtdbFindOneQuery;
  countDocuments(query?: any): RtdbCountQuery;
  updateOne(filter: any, update: any, options?: any): Promise<any>;
  updateMany(filter: any, update: any, options?: any): Promise<any>;
  findByIdAndUpdate(id: any, update: any, options?: any): Promise<any>;
  deleteOne(filter: any): Promise<any>;
  deleteMany(filter?: any): Promise<any>;
  findByIdAndDelete(id: any): Promise<any>;
  create(doc: any): Promise<any>;
  insertMany(docs: any[]): Promise<any[]>;
  aggregate(pipeline: any[]): Promise<any[]>;
}

export function getFirebaseModel(_modelName: string, collectionPath: string): FirebaseModel {
  const all = async (): Promise<{ map: DocMap; docs: any[] }> => {
    const map = await ensureCollection(collectionPath);
    return { map, docs: Array.from(map.values()) };
  };

  const saveDoc = async (map: DocMap, key: string, doc: any) => {
    map.set(key, doc);
    await persistDoc(collectionPath, key, doc);
  };

  const model: FirebaseModel = {
    collectionPath,

    find(query?: any) {
      return new RtdbFindQuery(collectionPath, query);
    },

    findOne(query?: any) {
      return new RtdbFindOneQuery(collectionPath, query);
    },

    findById(id: any) {
      return new RtdbFindOneQuery(collectionPath, idQuery(id));
    },

    countDocuments(query?: any) {
      return new RtdbCountQuery(collectionPath, query);
    },

    async updateOne(filter: any, update: any, options?: any) {
      const { map, docs } = await all();
      const match = docs.find(d => matchesQuery(d, filter));
      if (match) {
        applyUpdate(match, update, false);
        match.updatedAt = match.updatedAt || Date.now();
        await saveDoc(map, keyOf(map, match), match);
        return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
      }
      if (options && (options as any).upsert) {
        const fresh: any = { _fid: `id_${Date.now()}_${Math.floor(Math.random() * 1e6)}` };
        if (filter && typeof filter === 'object') {
          for (const [k, v] of Object.entries(filter)) {
            if (!k.startsWith('$') && (typeof v === 'string' || typeof v === 'number')) setPath(fresh, k, v);
          }
        }
        applyUpdate(fresh, update, true);
        fresh.createdAt = fresh.createdAt || Date.now();
        fresh.updatedAt = Date.now();
        const key = docKey(fresh);
        fresh._fid = key;
        await saveDoc(map, key, fresh);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true };
      }
      return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
    },

    async updateMany(filter: any, update: any, _options?: any) {
      const { map, docs } = await all();
      let n = 0;
      for (const d of docs) {
        if (matchesQuery(d, filter)) {
          applyUpdate(d, update, false);
          d.updatedAt = d.updatedAt || Date.now();
          await saveDoc(map, keyOf(map, d), d);
          n++;
        }
      }
      return { matchedCount: n, modifiedCount: n, acknowledged: true };
    },

    async findByIdAndUpdate(id: any, update: any, options?: any) {
      const { map, docs } = await all();
      const q = idQuery(id);
      const match = docs.find(d => matchesQuery(d, q));
      if (!match) return null;
      const before = clone(match);
      applyUpdate(match, update, false);
      match.updatedAt = Date.now();
      const key = keyOf(map, match);
      await saveDoc(map, key, match);
      return (options as any)?.new ? attachSave(collectionPath, map, key, clone(match)) : before;
    },

    async deleteOne(filter: any) {
      const { map, docs } = await all();
      const match = docs.find(d => matchesQuery(d, filter));
      if (!match) return { deletedCount: 0 };
      const key = keyOf(map, match);
      map.delete(key);
      await deleteRemoteDoc(collectionPath, key);
      return { deletedCount: 1 };
    },

    async deleteMany(filter?: any) {
      const { map, docs } = await all();
      const matched = docs.filter(d => matchesQuery(d, filter));
      for (const d of matched) {
        const key = keyOf(map, d);
        map.delete(key);
        await deleteRemoteDoc(collectionPath, key);
      }
      return { deletedCount: matched.length };
    },

    async findByIdAndDelete(id: any) {
      const { map, docs } = await all();
      const match = docs.find(d => matchesQuery(d, idQuery(id)));
      if (!match) return null;
      const key = keyOf(map, match);
      map.delete(key);
      await deleteRemoteDoc(collectionPath, key);
      return clone(match);
    },

    async create(doc: any) {
      const { map } = await all();
      const fresh = clone(doc) || {};
      const now = Date.now();
      fresh.createdAt = fresh.createdAt || now;
      fresh.updatedAt = now;
      const key = docKey(fresh);
      fresh._fid = key;
      await saveDoc(map, key, fresh);
      return attachSave(collectionPath, map, key, clone(fresh));
    },

    async insertMany(docsArr: any[]) {
      const out: any[] = [];
      for (const d of docsArr || []) {
        out.push(await model.create(d));
      }
      return out;
    },

    async aggregate(pipeline: any[]) {
      const { docs } = await all();
      let rows = docs.map(clone);
      for (const stage of pipeline || []) {
        if ((stage as any).$match) {
          rows = rows.filter(d => matchesQuery(d, (stage as any).$match));
        } else if ((stage as any).$group) {
          const spec = (stage as any).$group;
          const groups = new Map<string, any>();
          const groupKeyOf = (d: any) => {
            if (spec._id === null || spec._id === undefined) return '__all__';
            if (typeof spec._id === 'string' && spec._id.startsWith('$')) return String(getPath(d, spec._id.slice(1)));
            return JSON.stringify(spec._id);
          };
          for (const d of rows) {
            const gk = groupKeyOf(d);
            if (!groups.has(gk)) {
              const g: any = { _id: spec._id === null ? null : gk };
              for (const [field, expr] of Object.entries<any>(spec)) {
                if (field === '_id') continue;
                if ((expr as any).$sum !== undefined) g[field] = 0;
                else if ((expr as any).$avg !== undefined) { g[field] = 0; g[`__${field}_n`] = 0; }
                else if ((expr as any).$min !== undefined) g[field] = undefined;
                else if ((expr as any).$max !== undefined) g[field] = undefined;
                else if ((expr as any).$first !== undefined) g[field] = undefined;
                else if ((expr as any).$last !== undefined) g[field] = undefined;
                else if ((expr as any).$count !== undefined) g[field] = 0;
              }
              groups.set(gk, g);
            }
            const g = groups.get(gk);
            for (const [field, expr] of Object.entries<any>(spec)) {
              if (field === '_id') continue;
              const e: any = expr;
              if (e.$sum !== undefined) {
                g[field] += e.$sum === 1 ? 1 : Number(refVal(d, e.$sum)) || 0;
              } else if (e.$avg !== undefined) {
                const v = Number(refVal(d, e.$avg));
                if (Number.isFinite(v)) { g[field] += v; g[`__${field}_n`]++; }
              } else if (e.$min !== undefined) {
                const v = refVal(d, e.$min);
                if (g[field] === undefined || v < g[field]) g[field] = v;
              } else if (e.$max !== undefined) {
                const v = refVal(d, e.$max);
                if (g[field] === undefined || v > g[field]) g[field] = v;
              } else if (e.$first !== undefined) {
                if (g[field] === undefined) g[field] = refVal(d, e.$first);
              } else if (e.$last !== undefined) {
                g[field] = refVal(d, e.$last);
              } else if (e.$count !== undefined) {
                g[field]++;
              }
            }
          }
          rows = Array.from(groups.values()).map(g => {
            const out: any = { _id: g._id };
            for (const [field, expr] of Object.entries<any>(spec)) {
              if (field === '_id') continue;
              if ((expr as any).$avg !== undefined) {
                const n = g[`__${field}_n`] || 0;
                out[field] = n > 0 ? g[field] / n : null;
              } else {
                out[field] = g[field];
              }
            }
            return out;
          });
        } else if ((stage as any).$sort) {
          rows = sortDocs(rows, (stage as any).$sort);
        } else if ((stage as any).$limit !== undefined) {
          rows = rows.slice(0, Number((stage as any).$limit));
        }
      }
      return rows;
    }
  };

  return model;
}

function refVal(doc: any, ref: any): any {
  if (typeof ref === 'string' && ref.startsWith('$')) return getPath(doc, ref.slice(1));
  return ref;
}

function keyOf(map: DocMap, doc: any): string {
  for (const [k, v] of map.entries()) {
    if (v === doc) return k;
  }
  const fallback = docKey(doc);
  map.set(fallback, doc);
  return fallback;
}

function defineModel(_modelName: string, collectionPath: string): FirebaseModel {
  return getFirebaseModel(_modelName, collectionPath);
}

// ---------- collections (same data, Firebase paths under shipu-messsenger-bot) ----------

export const UserModel = defineModel('User', 'users');
export const ThreadModel = defineModel('Thread', 'threads');
export const AdminBotModel = defineModel('AdminBot', 'adminbots');
export const FtpConfigModel = defineModel('FtpConfig', 'ftpconfigs');
export const AuditLogModel = defineModel('AuditLog', 'auditlogs');
export const StoredCommandModel = defineModel('StoredCommand', 'storedcommands');
export const SystemCredentialModel = defineModel('SystemCredential', 'systemcredentials');
export const BotSettingModel = defineModel('BotSetting', 'botsettings');
export const MessengerAccountModel = defineModel('MessengerAccount', 'messenger-accounts');
export const OfficialGroupModel = defineModel('OfficialGroup', 'officialgroups');
export const SharedAccessUserModel = defineModel('SharedAccessUser', 'sharedaccessusers');
export const PersonalAIAccountModel = defineModel('PersonalAIAccount', 'personal-ai-accounts');
export const SubscriptionModel = defineModel('Subscription', 'subscriptions');
export const SubscriptionPaymentModel = defineModel('SubscriptionPayment', 'subscriptionpayments');
export const BrainMemoryModel = defineModel('BrainMemory', 'brainmemories');
export const BrainSuggestionModel = defineModel('BrainSuggestion', 'brainsuggestions');
export const AIOSSessionModel = defineModel('AIOSSession', 'aiossessions');
export const AIOSMemoryModel = defineModel('AIOSMemory', 'aiosmemories');
export const AIOSUsageModel = defineModel('AIOSUsage', 'aiosusages');
export const AILogModel = defineModel('AILog', 'ailogs');
export const MessageLogModel = defineModel('MessageLog', 'messagelogs');
export const ThreadMemoryModel = defineModel('ThreadMemory', 'threadmemories');
export const AIFeedbackModel = defineModel('AIFeedback', 'aifeedbacks');
export const InferredAttributeModel = defineModel('InferredAttribute', 'inferredattributes');
export const FallbackApiModel = defineModel('FallbackApi', 'fallbackapis') as FirebaseModel;
export const TelegramConfigModel = defineModel('TelegramConfig', 'telegramconfigs');
export const CookieModel = defineModel('cookie', 'cookies');
export const QueueModel = defineModel('queue', 'queues');
export const HeartbeatModel = defineModel('heartbeat', 'heartbeats');
export const ClientLogModel = defineModel('client_log', 'client-logs');
export const EconomyTransactionModel = defineModel('EconomyTransaction', 'economytransactions');
export const EconomyConfigModel = defineModel('EconomyConfig', 'economyconfigs');
export const UserSpinModel = defineModel('UserSpin', 'userspins');

// ---------- local file fallback (offline safety, replaces old local_db_fallback path) ----------

const FALLBACK_DB_PATH = path.join(process.cwd(), 'local_db_fallback.json');

class LocalFallbackDatabase {
  private data: Record<string, any[]> = {};
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(FALLBACK_DB_PATH)) {
        this.data = JSON.parse(fs.readFileSync(FALLBACK_DB_PATH, 'utf8'));
      }
    } catch (err) {
      console.error('[FallbackDB] Error loading local DB:', err);
    }
  }

  private save() {
    try {
      fs.writeFileSync(FALLBACK_DB_PATH, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[FallbackDB] Error saving local DB:', err);
    }
  }

  getCollection(name: string): any[] {
    this.load();
    const colName = String(name).toLowerCase();
    if (!this.data[colName]) this.data[colName] = [];
    return this.data[colName];
  }

  setCollection(name: string, items: any[]) {
    this.load();
    this.data[String(name).toLowerCase()] = items;
    this.save();
  }
}

const fallbackDb = new LocalFallbackDatabase();

export function executeFallback(modelName: string, prop: string, args: any[]): any {
  const p = prop;
  if (p === 'find') {
    const col = fallbackDb.getCollection(modelName);
    const matched = col.filter(item => matchesQuery(item, args[0]));
    return new RtdbFindQuery('__fallback__', {}, matched);
  }
  if (p === 'findOne' || p === 'findById') {
    const col = fallbackDb.getCollection(modelName);
    const query = typeof args[0] === 'object' && args[0] !== null ? args[0] : idQuery(args[0]);
    const matched = col.find(item => matchesQuery(item, query)) || null;
    return new RtdbFindOneQuery('__fallback__', {}, matched);
  }
  if (p === 'updateOne' || p === 'findByIdAndUpdate') {
    const col = fallbackDb.getCollection(modelName);
    const query = typeof args[0] === 'object' && args[0] !== null ? args[0] : idQuery(args[0]);
    const idx = col.findIndex(item => matchesQuery(item, query));
    const update = args[1];
    const options = args[2];
    if (idx >= 0) {
      applyUpdate(col[idx], update, false);
      fallbackDb.setCollection(modelName, col);
      return Promise.resolve({ matchedCount: 1, modifiedCount: 1, acknowledged: true });
    }
    if (options && (options as any).upsert) {
      const fresh: any = {};
      applyUpdate(fresh, update, true);
      col.push(fresh);
      fallbackDb.setCollection(modelName, col);
      return Promise.resolve({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true });
    }
    return Promise.resolve({ matchedCount: 0, modifiedCount: 0, acknowledged: true });
  }
  if (p === 'updateMany') {
    const col = fallbackDb.getCollection(modelName);
    let n = 0;
    for (const item of col) {
      if (matchesQuery(item, args[0])) {
        applyUpdate(item, args[1], false);
        n++;
      }
    }
    fallbackDb.setCollection(modelName, col);
    return Promise.resolve({ matchedCount: n, modifiedCount: n, acknowledged: true });
  }
  if (p === 'deleteOne' || p === 'findByIdAndDelete') {
    const col = fallbackDb.getCollection(modelName);
    const query = typeof args[0] === 'object' && args[0] !== null ? args[0] : idQuery(args[0]);
    const idx = col.findIndex(item => matchesQuery(item, query));
    if (idx >= 0) {
      const [removed] = col.splice(idx, 1);
      fallbackDb.setCollection(modelName, col);
      return Promise.resolve(p === 'findByIdAndDelete' ? removed : { deletedCount: 1 });
    }
    return Promise.resolve(p === 'findByIdAndDelete' ? null : { deletedCount: 0 });
  }
  if (p === 'deleteMany') {
    const col = fallbackDb.getCollection(modelName);
    const kept = col.filter(item => !matchesQuery(item, args[0]));
    const n = col.length - kept.length;
    fallbackDb.setCollection(modelName, col);
    return Promise.resolve({ deletedCount: n });
  }
  if (p === 'create' || p === 'insertMany') {
    const col = fallbackDb.getCollection(modelName);
    const docs = p === 'create' ? [args[0]] : (args[0] || []);
    col.push(...docs);
    fallbackDb.setCollection(modelName, col);
    return Promise.resolve(p === 'create' ? docs[0] : docs);
  }
  if (p === 'countDocuments') {
    const col = fallbackDb.getCollection(modelName);
    return new RtdbCountQuery('__fallback__', {}, col.filter(item => matchesQuery(item, args[0])).length);
  }
  return new RtdbFindQuery('__fallback__', {}, []);
}

export function isDatabaseConnectionError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message || err).toLowerCase();
  return (
    msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('timed out') ||
    msg.includes('network') || msg.includes('econn') || msg.includes('enotfound') ||
    msg.includes('socket') || msg.includes('abort') || msg.includes('rtdb http 5') ||
    msg.includes('offline') || msg.includes('disconnected') || msg.includes('failed')
  );
}

// ---------- connect / status (replaces connectDatabase / getDatabaseStatus) ----------

let connectInFlight: Promise<{ connected: boolean; error?: string }> | null = null;

export async function connectDatabase(): Promise<{ connected: boolean; error?: string }> {
  if (dbConnected && collectionLoaded.size > 0) return { connected: true };
  if (connectInFlight) return connectInFlight;
  connectInFlight = (async () => {
    try {
      console.log('[DATABASE] Firebase configuration loaded');
      console.log('[DATABASE] Connecting to Firebase Realtime Database...');
      if (!baseUrl()) {
        return { connected: false, error: 'Firebase databaseURL is not configured.' };
      }
      // Preload the hot collections so first requests never wait on cold fetch.
      for (const coll of ['messenger-accounts', 'botsettings', 'storedcommands', 'adminbots', 'fallbackapis']) {
        await ensureCollection(coll);
      }
      if (!dbConnected) {
        return { connected: false, error: dbError || 'Firebase RTDB unreachable.' };
      }
      console.log('[SUCCESS][DATABASE] Firebase RTDB connection established successfully');
      console.log('[DATABASE] Runtime storage: ONLINE (Firebase Mode)');
      await ensureDefaultSeeds();
      return { connected: true };
    } catch (err: any) {
      dbConnected = false;
      dbError = err?.message || 'Firebase connection failed';
      console.warn('[DATABASE] Firebase RTDB offline (local fallback active):', dbError);
      return { connected: false, error: dbError };
    } finally {
      connectInFlight = null;
    }
  })();
  return connectInFlight;
}

export function isDatabaseConnected(): boolean {
  return dbConnected;
}

export function getDatabaseStatus(): { connected: boolean; status: string; transport: string; database: string; error?: string } {
  if (dbConnected) {
    return { connected: true, status: 'ONLINE', transport: 'Firebase RTDB', database: 'shipu-ai RTDB' };
  }
  return { connected: false, status: 'OFFLINE', transport: 'Firebase RTDB', database: 'shipu-ai RTDB', error: dbError || 'Disconnected' };
}

async function ensureDefaultSeeds(): Promise<void> {
  try {
    // Seed initial admin bots if empty (same behavior as the old Mongo layer).
    const admins = await (AdminBotModel.find({}) as any);
    if (!admins || admins.length === 0) {
      for (const uid of initialAdminBot) {
        await AdminBotModel.create({ uid, addedBy: 'SYSTEM_CONFIG', addedAt: new Date().toISOString(), role: 'OWNER' });
      }
      console.log('[DATABASE] Seeded initial admin bots');
    }

    // Seed OpenRouter fallback APIs if empty (preserves previous runtime catalog).
    const existing = await (FallbackApiModel.find({ name: { $regex: '^OpenRouter Free' } }) as any);
    if (!existing || existing.length === 0) {
      const { OPENROUTER_PRIMARY_KEY } = await import('../config/aiKeys');
      const openRouterModels = [
        { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B' },
        { id: 'openai/gpt-oss-20b:free', label: 'GPT OSS 20B' },
        { id: 'cohere/north-mini-code:free', label: 'Cohere North Mini Code' },
        { id: 'google/gemma-2-9b-it:free', label: 'Gemma 2 9B' },
        { id: 'meta-llama/llama-3-8b-instruct:free', label: 'Llama 3 8B Instruct' },
        { id: 'meta-llama/llama-3.1-8b-instruct:free', label: 'Llama 3.1 8B Instruct' },
        { id: 'mistralai/mistral-7b-instruct:free', label: 'Mistral 7B Instruct' },
        { id: 'qwen/qwen-2-7b-instruct:free', label: 'Qwen 2 7B Instruct' },
        { id: 'microsoft/phi-3-medium-128k-instruct:free', label: 'Phi 3 Medium' },
        { id: 'openchat/openchat-7b:free', label: 'OpenChat 7B' }
      ];
      await FallbackApiModel.insertMany(openRouterModels.map(m => ({
        name: `OpenRouter Free - ${m.label}`,
        url: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: OPENROUTER_PRIMARY_KEY,
        model: m.id,
        enabled: true,
        priority: 5
      })));
      console.log('[DATABASE] Seeded OpenRouter fallback APIs');
    }
  } catch (seedErr: any) {
    console.warn('[DATABASE] Default seed skipped:', seedErr?.message || seedErr);
  }
}
