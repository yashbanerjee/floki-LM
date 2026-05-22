import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import { createSession, getSessions, updateSession, deleteSession, addMessage, getMessages, saveMedia, getMedia } from './db';
import './App.css';

const MODELS = [
  { id: 'qwen25-7b', label: 'Qwen 2.5 7B', vision: false },
  { id: 'gemma4:e4b', label: 'Gemma 4 E4B', vision: true },
  { id: 'gemma4:26b', label: 'Gemma 4 26B', vision: true },
  { id: 'gemma4:31b', label: 'Gemma 4 31B', vision: true },
];

const API = 'https://llm.ved.ae';

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function renderMD(text) {
  try { return marked.parse(text, { breaks: true, gfm: true }); }
  catch { return text; }
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(MODELS[0].id);
  const [streaming, setStreaming] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingMedia, setPendingMedia] = useState(null); // {file, previewUrl, base64}
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionMetrics, setSessionMetrics] = useState({ msgs: 0, tokens: 0, tpsArr: [], rtArr: [], ttftArr: [] });
  const messagesEndRef = useRef(null);
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => { loadSessions(); }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadSessions() {
    const s = await getSessions();
    setSessions(s);
  }

  async function newChat() {
    const session = await createSession(model);
    setSessions(prev => [session, ...prev]);
    setActiveSession(session);
    setMessages([]);
    setSessionMetrics({ msgs: 0, tokens: 0, tpsArr: [], rtArr: [], ttftArr: [] });
    setPendingMedia(null);
  }

  async function openSession(session) {
    setActiveSession(session);
    setModel(session.model);
    const msgs = await getMessages(session.id);
    // Load media for messages
    const enriched = await Promise.all(msgs.map(async m => {
      if (m.mediaId) {
        const media = await getMedia(m.mediaId);
        if (media) {
          const blob = new Blob([media.data], { type: media.type });
          m.mediaUrl = URL.createObjectURL(blob);
        }
      }
      return m;
    }));
    setMessages(enriched);
    setSessionMetrics({ msgs: enriched.filter(m => m.role === 'assistant').length, tokens: 0, tpsArr: [], rtArr: [], ttftArr: [] });
    setPendingMedia(null);
  }

  async function handleDeleteSession(e, id) {
    e.stopPropagation();
    await deleteSession(id);
    if (activeSession?.id === id) {
      setActiveSession(null);
      setMessages([]);
    }
    loadSessions();
  }

  async function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      setPendingMedia({ file, previewUrl, base64, type: file.type });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function removePendingMedia() {
    if (pendingMedia) URL.revokeObjectURL(pendingMedia.previewUrl);
    setPendingMedia(null);
  }

  async function send() {
    if (isGenerating) { abortRef.current?.abort(); return; }
    const text = input.trim();
    if (!text && !pendingMedia) return;

    let session = activeSession;
    if (!session) {
      session = await createSession(model);
      setSessions(prev => [session, ...prev]);
      setActiveSession(session);
    }

    // Save media to DB
    let mediaId = null;
    let mediaUrl = null;
    if (pendingMedia) {
      mediaId = await saveMedia(pendingMedia.file);
      mediaUrl = pendingMedia.previewUrl;
    }

    // Add user message to DB and state
    const userMsg = await addMessage(session.id, 'user', text, mediaId);
    userMsg.mediaUrl = mediaUrl;
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setPendingMedia(null);

    // Update session title if first message
    if (session.messageCount === 0) {
      const title = text.slice(0, 40) || 'Image chat';
      await updateSession(session.id, { title, model, messageCount: 1 });
      setSessions(prev => prev.map(s => s.id === session.id ? { ...s, title, messageCount: 1 } : s));
    }

    setIsGenerating(true);
    const reqStart = Date.now();
    let ttft = null;
    abortRef.current = new AbortController();

    // Build messages for API
    const history = (await getMessages(session.id)).slice(0, -1); // exclude the one we just added
    const selectedModel = MODELS.find(m => m.id === model);
    const apiMessages = await Promise.all([...history, userMsg].map(async m => {
      if (m.mediaId && selectedModel?.vision) {
        const media = await getMedia(m.mediaId);
        if (media) {
          const b64 = btoa(String.fromCharCode(...new Uint8Array(media.data)));
          return {
            role: m.role,
            content: [
              { type: 'image_url', image_url: { url: `data:${media.type};base64,${b64}` } },
              { type: 'text', text: m.content || 'Describe this image.' }
            ]
          };
        }
      }
      return { role: m.role, content: m.content };
    }));

    // Add thinking message
    const thinkingId = 'thinking-' + Date.now();
    setMessages(prev => [...prev, { id: thinkingId, role: 'thinking' }]);

    try {
      if (streaming) {
        const res = await fetch(`${API}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: apiMessages, stream: true }),
          signal: abortRef.current.signal,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        // Remove thinking, add streaming message
        const streamMsgId = 'stream-' + Date.now();
        setMessages(prev => prev.filter(m => m.id !== thinkingId).concat({ id: streamMsgId, role: 'assistant', content: '', streaming: true }));

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '', evalCount = 0, evalDuration = 0, first = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = decoder.decode(value, { stream: true }).split('\n').filter(l => l.trim());
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.message?.content) {
                if (first) { ttft = ((Date.now() - reqStart) / 1000).toFixed(2); first = false; }
                full += d.message.content;
                setMessages(prev => prev.map(m => m.id === streamMsgId ? { ...m, content: full } : m));
              }
              if (d.done) {
                evalCount = d.eval_count || 0;
                evalDuration = d.eval_duration || 0;
                const rt = ((Date.now() - reqStart) / 1000).toFixed(2);
                const tps = evalCount && evalDuration ? (evalCount / (evalDuration / 1e9)).toFixed(1) : null;
                const gen = evalDuration ? (evalDuration / 1e9).toFixed(2) : null;
                setMessages(prev => prev.map(m => m.id === streamMsgId ? { ...m, streaming: false, metrics: { ttft, rt, tps, tokens: evalCount, gen } } : m));
                setSessionMetrics(prev => ({
                  msgs: prev.msgs + 1,
                  tokens: prev.tokens + evalCount,
                  tpsArr: tps ? [...prev.tpsArr, parseFloat(tps)] : prev.tpsArr,
                  rtArr: [...prev.rtArr, parseFloat(rt)],
                  ttftArr: ttft ? [...prev.ttftArr, parseFloat(ttft)] : prev.ttftArr,
                }));
                // Save to DB
                const saved = await addMessage(session.id, 'assistant', full);
                setMessages(prev => prev.map(m => m.id === streamMsgId ? { ...saved, metrics: { ttft, rt, tps, tokens: evalCount, gen } } : m));
              }
            } catch {}
          }
        }
      } else {
        const res = await fetch(`${API}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: apiMessages, stream: false }),
          signal: abortRef.current.signal,
        });
        ttft = ((Date.now() - reqStart) / 1000).toFixed(2);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        setMessages(prev => prev.filter(m => m.id !== thinkingId));
        if (d.message?.content) {
          const rt = ((Date.now() - reqStart) / 1000).toFixed(2);
          const tps = d.eval_count && d.eval_duration ? (d.eval_count / (d.eval_duration / 1e9)).toFixed(1) : null;
          const gen = d.eval_duration ? (d.eval_duration / 1e9).toFixed(2) : null;
          const saved = await addMessage(session.id, 'assistant', d.message.content);
          saved.metrics = { ttft, rt, tps, tokens: d.eval_count || 0, gen };
          setMessages(prev => [...prev, saved]);
          setSessionMetrics(prev => ({
            msgs: prev.msgs + 1, tokens: prev.tokens + (d.eval_count || 0),
            tpsArr: tps ? [...prev.tpsArr, parseFloat(tps)] : prev.tpsArr,
            rtArr: [...prev.rtArr, parseFloat(rt)],
            ttftArr: ttft ? [...prev.ttftArr, parseFloat(ttft)] : prev.ttftArr,
          }));
        }
      }
    } catch (e) {
      setMessages(prev => prev.filter(m => m.id !== thinkingId).filter(m => !m.streaming));
      if (e.name !== 'AbortError') {
        setMessages(prev => [...prev, { id: Date.now(), role: 'error', content: e.message }]);
      }
    }
    setIsGenerating(false);
    textareaRef.current?.focus();
  }

  const currentModel = MODELS.find(m => m.id === model);
  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '—';

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-dot" />
            <span className="brand-name">Vedha LLM</span>
          </div>
          <button className="icon-btn" onClick={() => setSidebarOpen(false)}>✕</button>
        </div>

        <button className="new-chat-btn" onClick={newChat}>
          <span>+</span> New chat
        </button>

        {/* Model selector */}
        <div className="model-section">
          <div className="section-label">Model</div>
          <div className="model-list">
            {MODELS.map(m => (
              <button key={m.id} className={`model-btn ${model === m.id ? 'active' : ''}`} onClick={() => setModel(m.id)}>
                <span className="model-name">{m.label}</span>
                {m.vision && <span className="vision-badge">👁</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Sessions */}
        <div className="sessions-section">
          <div className="section-label">Chats</div>
          <div className="sessions-list">
            {sessions.length === 0 && <div className="empty-sessions">No chats yet</div>}
            {sessions.map(s => (
              <div key={s.id} className={`session-item ${activeSession?.id === s.id ? 'active' : ''}`} onClick={() => openSession(s)}>
                <div className="session-info">
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">{timeAgo(s.updatedAt)}</div>
                </div>
                <button className="delete-btn" onClick={e => handleDeleteSession(e, s.id)}>✕</button>
              </div>
            ))}
          </div>
        </div>

        {/* Session stats */}
        {activeSession && (
          <div className="stats-panel">
            <div className="section-label">Session stats</div>
            <div className="stats-grid">
              <div className="stat"><div className="stat-l">Messages</div><div className="stat-v">{sessionMetrics.msgs}</div></div>
              <div className="stat"><div className="stat-l">Tokens</div><div className="stat-v">{sessionMetrics.tokens.toLocaleString()}</div></div>
              <div className="stat"><div className="stat-l">Avg tok/s</div><div className="stat-v accent">{avg(sessionMetrics.tpsArr)}{sessionMetrics.tpsArr.length ? ' t/s' : ''}</div></div>
              <div className="stat"><div className="stat-l">Avg TTFT</div><div className="stat-v">{avg(sessionMetrics.ttftArr)}{sessionMetrics.ttftArr.length ? 's' : ''}</div></div>
            </div>
          </div>
        )}

        <div className="sidebar-footer">llm.ved.ae · RTX 3090</div>
      </aside>

      {/* Main */}
      <main className="main">
        {/* Topbar */}
        <div className="topbar">
          {!sidebarOpen && <button className="icon-btn" onClick={() => setSidebarOpen(true)}>☰</button>}
          <div className="topbar-model">
            <span className="topbar-model-name">{currentModel?.label}</span>
            {currentModel?.vision && <span className="vision-pill">Vision</span>}
          </div>
          <label className="stream-toggle">
            <input type="checkbox" checked={streaming} onChange={e => setStreaming(e.target.checked)} />
            <span>Stream</span>
          </label>
        </div>

        {/* Messages */}
        <div className="messages">
          {!activeSession && messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-logo">⬡</div>
              <h2>Vedha LLM</h2>
              <p>Local AI — private, fast, free</p>
              <div className="welcome-models">
                {MODELS.map(m => (
                  <button key={m.id} className={`welcome-model-btn ${model === m.id ? 'active' : ''}`} onClick={() => setModel(m.id)}>
                    {m.label} {m.vision ? '👁' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={`msg-wrap ${msg.role}`}>
              {msg.role === 'thinking' && (
                <div className="msg thinking-msg">
                  <span className="dot" /><span className="dot" /><span className="dot" />
                </div>
              )}
              {msg.role === 'user' && (
                <div className="msg user-msg">
                  {msg.mediaUrl && <img src={msg.mediaUrl} className="msg-image" alt="uploaded" />}
                  {msg.content && <p>{msg.content}</p>}
                </div>
              )}
              {(msg.role === 'assistant') && (
                <div className="msg assistant-msg">
                  <div className="msg-content" dangerouslySetInnerHTML={{ __html: renderMD(msg.content) }} />
                  {msg.streaming && <span className="cursor">▍</span>}
                  {msg.metrics && (
                    <div className="msg-metrics">
                      {msg.metrics.ttft && <span>TTFT {msg.metrics.ttft}s</span>}
                      {msg.metrics.rt && <span>Response {msg.metrics.rt}s</span>}
                      {msg.metrics.tps && <span>{msg.metrics.tps} tok/s</span>}
                      {msg.metrics.tokens && <span>{msg.metrics.tokens} tokens</span>}
                      {msg.metrics.gen && <span>Gen {msg.metrics.gen}s</span>}
                    </div>
                  )}
                </div>
              )}
              {msg.role === 'error' && (
                <div className="msg error-msg">⚠ {msg.content}</div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="input-area">
          {pendingMedia && (
            <div className="media-preview">
              <img src={pendingMedia.previewUrl} alt="pending" />
              <button className="remove-media" onClick={removePendingMedia}>✕</button>
            </div>
          )}
          <div className="input-row">
            {currentModel?.vision && (
              <>
                <button className="attach-btn" onClick={() => fileInputRef.current?.click()}>📎</button>
                <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileSelect} />
              </>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px'; }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={currentModel?.vision ? 'Message or attach an image...' : 'Message...'}
              rows={1}
            />
            <button className={`send-btn ${isGenerating ? 'stop' : ''}`} onClick={send}>
              {isGenerating ? '■' : '↑'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
