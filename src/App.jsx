import { useState, useEffect, useRef } from 'react';
import { marked } from 'marked';
import { createSession, getSessions, updateSession, deleteSession, addMessage, getMessages, saveMedia, getMedia } from './db';
import './App.css';

const MODELS = [
  { 
    id: 'qwen25-7b', 
    label: 'Qwen 2.5 7B', 
    sublabel: 'Fast · Text only',
    vision: false,
    api: 'https://llm.ved.ae/api/chat',
    type: 'ollama'
  },
  { 
    id: 'gemma4', 
    label: 'Gemma 4 E4B', 
    sublabel: 'Vision · Multimodal',
    vision: true,
    api: 'https://gemma.ved.ae/v1/chat/completions',
    type: 'openai'
  },
];

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
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
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [streaming, setStreaming] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]); // [{file, previewUrl, base64, type}]
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [metrics, setMetrics] = useState({ msgs: 0, tokens: 0, tpsArr: [], rtArr: [], ttftArr: [] });
  const messagesEndRef = useRef(null);
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  const model = MODELS.find(m => m.id === modelId);

  useEffect(() => { loadSessions(); }, []);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function loadSessions() {
    setSessions(await getSessions());
  }

  async function newChat() {
    const s = await createSession(modelId);
    setSessions(prev => [s, ...prev]);
    setActiveSession(s);
    setMessages([]);
    setMetrics({ msgs: 0, tokens: 0, tpsArr: [], rtArr: [], ttftArr: [] });
    setPendingFiles([]);
  }

  async function openSession(s) {
    setActiveSession(s);
    setModelId(s.model);
    const msgs = await getMessages(s.id);
    const enriched = await Promise.all(msgs.map(async m => {
      if (m.mediaIds?.length) {
        m.mediaUrls = [];
        for (const id of m.mediaIds) {
          const media = await getMedia(id);
          if (media) m.mediaUrls.push({ url: URL.createObjectURL(new Blob([media.data], { type: media.type })), type: media.type });
        }
      }
      return m;
    }));
    setMessages(enriched);
    setPendingFiles([]);
  }

  async function handleDeleteSession(e, id) {
    e.stopPropagation();
    await deleteSession(id);
    if (activeSession?.id === id) { setActiveSession(null); setMessages([]); }
    loadSessions();
  }

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    const newFiles = await Promise.all(files.map(async file => {
      const previewUrl = URL.createObjectURL(file);
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve({ file, previewUrl, base64: reader.result.split(',')[1], type: file.type, name: file.name });
        reader.readAsDataURL(file);
      });
    }));
    setPendingFiles(prev => [...prev, ...newFiles]);
    e.target.value = '';
  }

  function removeFile(idx) {
    setPendingFiles(prev => { URL.revokeObjectURL(prev[idx].previewUrl); return prev.filter((_, i) => i !== idx); });
  }

  async function send() {
    if (isGenerating) { abortRef.current?.abort(); return; }
    const text = input.trim();
    if (!text && pendingFiles.length === 0) return;

    let session = activeSession;
    if (!session) {
      session = await createSession(modelId);
      setSessions(prev => [session, ...prev]);
      setActiveSession(session);
    }

    // Save media files
    const mediaIds = [];
    const mediaUrls = [];
    for (const f of pendingFiles) {
      const id = await saveMedia(f.file);
      mediaIds.push(id);
      mediaUrls.push({ url: f.previewUrl, type: f.type });
    }

    // Capture pendingFiles BEFORE clearing (needed for API call)
    const capturedFiles = [...pendingFiles];
    const userMsg = await addMessage(session.id, 'user', text, mediaIds.length ? mediaIds : null);
    userMsg.mediaUrls = mediaUrls;
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setPendingFiles([]);

    if (session.messageCount === 0) {
      const title = text.slice(0, 40) || `${pendingFiles.length} file(s)`;
      await updateSession(session.id, { title, model: modelId, messageCount: 1 });
      setSessions(prev => prev.map(s => s.id === session.id ? { ...s, title, messageCount: 1 } : s));
    }

    setIsGenerating(true);
    const reqStart = Date.now();
    let ttft = null;
    abortRef.current = new AbortController();

    // Build API messages
    const history = await getMessages(session.id);
    // Keep a reference to pending files base64 for the current message (before DB roundtrip)
    const currentMsgFiles = capturedFiles.length > 0 ? capturedFiles : null;
    const apiMessages = await Promise.all(history.map(async (m, idx) => {
      const isLastMsg = idx === history.length - 1;
      if (m.mediaIds?.length && model.vision) {
        const content = [];
        // For the last message, use pendingFiles base64 directly to avoid DB corruption
        if (isLastMsg && currentMsgFiles) {
          for (const f of currentMsgFiles) {
            if (f.type.startsWith('image/')) {
              content.push({ type: 'image_url', image_url: { url: `data:${f.type};base64,${f.base64}` } });
            }
          }
        } else {
          for (const id of m.mediaIds) {
            const media = await getMedia(id);
            if (media && media.type.startsWith('image/')) {
              const bytes = new Uint8Array(media.data);
              let binary = '';
              const chunkSize = 8192;
              for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
              }
              const b64 = btoa(binary);
              content.push({ type: 'image_url', image_url: { url: `data:${media.type};base64,${b64}` } });
            }
          }
        }
        content.push({ type: 'text', text: m.content || 'Describe what you see in this image.' });
        return { role: m.role, content };
      }
      return { role: m.role, content: m.content };
    }));

    const thinkId = 'thinking-' + Date.now();
    setMessages(prev => [...prev, { id: thinkId, role: 'thinking' }]);

    try {
      if (model.type === 'ollama') {
        await sendOllama(session, apiMessages, reqStart, thinkId, ttft);
      } else {
        await sendOpenAI(session, apiMessages, reqStart, thinkId, ttft);
      }
    } catch (e) {
      setMessages(prev => prev.filter(m => m.id !== thinkId).filter(m => !m.streaming));
      if (e.name !== 'AbortError') setMessages(prev => [...prev, { id: Date.now(), role: 'error', content: e.message }]);
    }

    setIsGenerating(false);
    textareaRef.current?.focus();
  }

  async function sendOllama(session, apiMessages, reqStart, thinkId) {
    let ttft = null;
    const res = await fetch('https://llm.ved.ae/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen25-7b', messages: apiMessages, stream: streaming }),
      signal: abortRef.current.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    if (streaming) {
      const streamId = 'stream-' + Date.now();
      setMessages(prev => prev.filter(m => m.id !== thinkId).concat({ id: streamId, role: 'assistant', content: '', streaming: true }));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '', evalCount = 0, evalDuration = 0, first = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n').filter(l => l.trim())) {
          try {
            const d = JSON.parse(line);
            if (d.message?.content) {
              if (first) { ttft = ((Date.now()-reqStart)/1000).toFixed(2); first = false; }
              full += d.message.content;
              setMessages(prev => prev.map(m => m.id === streamId ? { ...m, content: full } : m));
            }
            if (d.done) {
              evalCount = d.eval_count || 0; evalDuration = d.eval_duration || 0;
              const rt = ((Date.now()-reqStart)/1000).toFixed(2);
              const tps = evalCount && evalDuration ? (evalCount/(evalDuration/1e9)).toFixed(1) : null;
              const gen = evalDuration ? (evalDuration/1e9).toFixed(2) : null;
              const saved = await addMessage(session.id, 'assistant', full);
              setMessages(prev => prev.map(m => m.id === streamId ? { ...saved, metrics: { ttft, rt, tps, tokens: evalCount, gen } } : m));
              updateMetrics(evalCount, rt, tps, ttft);
            }
          } catch {}
        }
      }
    } else {
      const d = await res.json();
      setMessages(prev => prev.filter(m => m.id !== thinkId));
      if (d.message?.content) {
        ttft = ((Date.now()-reqStart)/1000).toFixed(2);
        const rt = ttft;
        const tps = d.eval_count && d.eval_duration ? (d.eval_count/(d.eval_duration/1e9)).toFixed(1) : null;
        const saved = await addMessage(session.id, 'assistant', d.message.content);
        saved.metrics = { ttft, rt, tps, tokens: d.eval_count||0, gen: d.eval_duration?(d.eval_duration/1e9).toFixed(2):null };
        setMessages(prev => [...prev, saved]);
        updateMetrics(d.eval_count||0, rt, tps, ttft);
      }
    }
  }

  async function sendOpenAI(session, apiMessages, reqStart, thinkId) {
    let ttft = null;
    const res = await fetch('https://gemma.ved.ae/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma4', messages: apiMessages, stream: streaming }),
      signal: abortRef.current.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    if (streaming) {
      const streamId = 'stream-' + Date.now();
      setMessages(prev => prev.filter(m => m.id !== thinkId).concat({ id: streamId, role: 'assistant', content: '', streaming: true }));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '', first = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n').filter(l => l.startsWith('data: '))) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            const rt = ((Date.now()-reqStart)/1000).toFixed(2);
            const saved = await addMessage(session.id, 'assistant', full);
            setMessages(prev => prev.map(m => m.id === streamId ? { ...saved, metrics: { ttft, rt, tokens: full.split(' ').length } } : m));
            updateMetrics(full.split(' ').length, rt, null, ttft);
            break;
          }
          try {
            const d = JSON.parse(data);
            const chunk = d.choices?.[0]?.delta?.content || '';
            if (chunk) {
              if (first) { ttft = ((Date.now()-reqStart)/1000).toFixed(2); first = false; }
              full += chunk;
              setMessages(prev => prev.map(m => m.id === streamId ? { ...m, content: full } : m));
            }
          } catch {}
        }
      }
    } else {
      ttft = null;
      const d = await res.json();
      setMessages(prev => prev.filter(m => m.id !== thinkId));
      const content = d.choices?.[0]?.message?.content || '';
      if (content) {
        const rt = ((Date.now()-reqStart)/1000).toFixed(2);
        ttft = rt;
        const tps = d.timings?.predicted_per_second?.toFixed(1) || null;
        const tokens = d.usage?.completion_tokens || 0;
        const saved = await addMessage(session.id, 'assistant', content);
        saved.metrics = { ttft, rt, tps, tokens, gen: d.timings ? (d.timings.predicted_ms/1000).toFixed(2) : null };
        setMessages(prev => [...prev, saved]);
        updateMetrics(tokens, rt, tps, ttft);
      }
    }
  }

  function updateMetrics(tokens, rt, tps, ttft) {
    setMetrics(prev => ({
      msgs: prev.msgs + 1,
      tokens: prev.tokens + tokens,
      tpsArr: tps ? [...prev.tpsArr, parseFloat(tps)] : prev.tpsArr,
      rtArr: [...prev.rtArr, parseFloat(rt)],
      ttftArr: ttft ? [...prev.ttftArr, parseFloat(ttft)] : prev.ttftArr,
    }));
  }

  const avg = arr => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(1) : '—';

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <div className="brand"><div className="brand-dot" /><span className="brand-name">Vedha LLM</span></div>
          <button className="icon-btn" onClick={() => setSidebarOpen(false)}>✕</button>
        </div>

        <button className="new-chat-btn" onClick={newChat}><span>+</span> New chat</button>

        <div className="model-section">
          <div className="section-label">Model</div>
          <div className="model-list">
            {MODELS.map(m => (
              <button key={m.id} className={`model-btn ${modelId === m.id ? 'active' : ''}`} onClick={() => setModelId(m.id)}>
                <div className="model-info">
                  <span className="model-name">{m.label}</span>
                  <span className="model-sub">{m.sublabel}</span>
                </div>
                {m.vision && <span className="vision-badge">👁</span>}
              </button>
            ))}
          </div>
        </div>

        <div className="sessions-section">
          <div className="section-label">Chats</div>
          <div className="sessions-list">
            {sessions.length === 0 && <div className="empty-sessions">No chats yet</div>}
            {sessions.map(s => (
              <div key={s.id} className={`session-item ${activeSession?.id === s.id ? 'active' : ''}`} onClick={() => openSession(s)}>
                <div className="session-info">
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">{MODELS.find(m=>m.id===s.model)?.label || s.model} · {timeAgo(s.updatedAt)}</div>
                </div>
                <button className="delete-btn" onClick={e => handleDeleteSession(e, s.id)}>✕</button>
              </div>
            ))}
          </div>
        </div>

        {activeSession && (
          <div className="stats-panel">
            <div className="section-label">Session stats</div>
            <div className="stats-grid">
              <div className="stat"><div className="stat-l">Messages</div><div className="stat-v">{metrics.msgs}</div></div>
              <div className="stat"><div className="stat-l">Tokens</div><div className="stat-v">{metrics.tokens.toLocaleString()}</div></div>
              <div className="stat"><div className="stat-l">Avg tok/s</div><div className="stat-v accent">{avg(metrics.tpsArr)}{metrics.tpsArr.length?'':''}</div></div>
              <div className="stat"><div className="stat-l">Avg TTFT</div><div className="stat-v">{avg(metrics.ttftArr)}{metrics.ttftArr.length?'s':''}</div></div>
            </div>
          </div>
        )}

        <div className="sidebar-footer">llm.ved.ae · gemma.ved.ae · RTX 3090</div>
      </aside>

      <main className="main">
        <div className="topbar">
          {!sidebarOpen && <button className="icon-btn" onClick={() => setSidebarOpen(true)}>☰</button>}
          <div className="topbar-model">
            <div className={`model-indicator ${modelId}`} />
            <span className="topbar-model-name">{model?.label}</span>
            {model?.vision && <span className="vision-pill">Vision</span>}
          </div>
          <label className="stream-toggle">
            <input type="checkbox" checked={streaming} onChange={e => setStreaming(e.target.checked)} />
            <span>Stream</span>
          </label>
        </div>

        <div className="messages">
          {!activeSession && messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-logo">⬡</div>
              <h2>Vedha LLM</h2>
              <p>Local AI — private, fast, free</p>
              <div className="welcome-models">
                {MODELS.map(m => (
                  <button key={m.id} className={`welcome-model-btn ${modelId === m.id ? 'active' : ''}`} onClick={() => setModelId(m.id)}>
                    <strong>{m.label}</strong>
                    <span>{m.sublabel}</span>
                    {m.vision && <span className="wm-badge">Vision</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={`msg-wrap ${msg.role}`}>
              {msg.role === 'thinking' && (
                <div className="msg thinking-msg"><span className="dot"/><span className="dot"/><span className="dot"/></div>
              )}
              {msg.role === 'user' && (
                <div className="msg user-msg">
                  {msg.mediaUrls?.length > 0 && (
                    <div className="msg-media">
                      {msg.mediaUrls.map((m, i) => (
                        m.type.startsWith('image/') 
                          ? <img key={i} src={m.url} className="msg-image" alt="uploaded" />
                          : <div key={i} className="msg-file">📄 File {i+1}</div>
                      ))}
                    </div>
                  )}
                  {msg.content && <p>{msg.content}</p>}
                </div>
              )}
              {msg.role === 'assistant' && (
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
              {msg.role === 'error' && <div className="msg error-msg">⚠ {msg.content}</div>}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area">
          {pendingFiles.length > 0 && (
            <div className="pending-files">
              {pendingFiles.map((f, i) => (
                <div key={i} className="pending-file">
                  {f.type.startsWith('image/') 
                    ? <img src={f.previewUrl} alt={f.name} />
                    : <div className="file-icon">📄<span>{f.name}</span></div>
                  }
                  <button className="remove-file" onClick={() => removeFile(i)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {model?.vision && (
            <div className="attach-bar">
              <button className="attach-btn" onClick={() => { fileInputRef.current.accept='image/*'; fileInputRef.current?.click(); }}>
                🖼 Image
              </button>
              <button className="attach-btn" onClick={() => { fileInputRef.current.accept='.pdf,.txt,.md,.csv,.json'; fileInputRef.current?.click(); }}>
                📄 File
              </button>
              <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
              <span className="attach-hint">Gemma 4 supports images and documents</span>
            </div>
          )}

          <div className="input-row">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,180)+'px'; }}
              onKeyDown={e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} }}
              placeholder={model?.vision ? 'Message, or attach an image/file above...' : 'Message...'}
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
