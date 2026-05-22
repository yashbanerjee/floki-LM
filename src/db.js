import { openDB } from 'idb';

const DB_NAME = 'vedha-llm';
const DB_VERSION = 1;

export async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Sessions store
      if (!db.objectStoreNames.contains('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('updatedAt', 'updatedAt');
      }
      // Messages store
      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('sessionId', 'sessionId');
      }
      // Media store
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'id' });
      }
    },
  });
}

export async function createSession(model) {
  const db = await getDB();
  const session = {
    id: crypto.randomUUID(),
    title: 'New chat',
    model,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
  };
  await db.put('sessions', session);
  return session;
}

export async function getSessions() {
  const db = await getDB();
  const sessions = await db.getAll('sessions');
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateSession(id, updates) {
  const db = await getDB();
  const session = await db.get('sessions', id);
  if (session) await db.put('sessions', { ...session, ...updates, updatedAt: Date.now() });
}

export async function deleteSession(id) {
  const db = await getDB();
  await db.delete('sessions', id);
  const allMsgs = await db.getAllFromIndex('messages', 'sessionId', id);
  const tx = db.transaction('messages', 'readwrite');
  for (const msg of allMsgs) tx.store.delete(msg.id);
  await tx.done;
}

export async function addMessage(sessionId, role, content, mediaId = null) {
  const db = await getDB();
  const msg = {
    id: crypto.randomUUID(),
    sessionId,
    role,
    content,
    mediaId,
    createdAt: Date.now(),
  };
  await db.put('messages', msg);
  return msg;
}

export async function getMessages(sessionId) {
  const db = await getDB();
  const msgs = await db.getAllFromIndex('messages', 'sessionId', sessionId);
  return msgs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveMedia(file) {
  const db = await getDB();
  const id = crypto.randomUUID();
  const buffer = await file.arrayBuffer();
  await db.put('media', { id, name: file.name, type: file.type, data: buffer, createdAt: Date.now() });
  return id;
}

export async function getMedia(id) {
  const db = await getDB();
  return db.get('media', id);
}
