import { useState, useRef, useEffect } from "react";

const SYSTEM_PROMPT = `You are an expert web developer AI assistant. The user has cloned a webpage and you help them modify its HTML/CSS/JS code.

When the user asks for changes, respond ONLY with a JSON object in this exact format:
{
  "explanation": "Brief description of what you changed",
  "html": "COMPLETE updated HTML code"
}

Always return the full HTML document with all changes applied. Make precise, clean modifications.`;

function makeAbsolute(html: string, pageUrl: string): string {
  try {
    const base = new URL(pageUrl);
    const origin = base.origin;
    const basePath = base.href.replace(/\/[^/]*$/, "/");
    return html
      .replace(/(src|href|action)=["'](?!https?:\/\/|\/\/|data:|#|mailto:|javascript:)([^"']+)["']/gi,
        (_m, attr, path) => {
          try {
            const abs = path.startsWith("/") ? origin + path : basePath + path;
            return `${attr}="${abs}"`;
          } catch { return _m; }
        })
      .replace(/url\(['"]?(?!https?:\/\/|\/\/|data:)([^'")]+)['"]?\)/gi,
        (_m, path) => {
          try {
            const abs = path.startsWith("/") ? origin + path : basePath + path;
            return `url("${abs}")`;
          } catch { return _m; }
        });
  } catch { return html; }
}

type Message = { role: "user" | "assistant"; content: string };
const TABS = ["preview", "code", "chat"] as const;

export default function App() {
  const [url, setUrl] = useState("");
  const [clonedHtml, setClonedHtml] = useState("");
  const [originalHtml, setOriginalHtml] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [activeTab, setActiveTab] = useState<"preview"|"code"|"chat">("preview");
  const [cloneError, setCloneError] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubFile, setGithubFile] = useState("index.html");
  const [showGithub, setShowGithub] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  useEffect(() => {
    if (clonedHtml && iframeRef.current && activeTab === "preview") {
      const blob = new Blob([clonedHtml], { type: "text/html" });
      const blobUrl = URL.createObjectURL(blob);
      iframeRef.current.src = blobUrl;
      return () => URL.revokeObjectURL(blobUrl);
    }
  }, [clonedHtml, activeTab]);

  const handleClone = async () => {
    if (!url.trim()) return;
    setCloning(true);
    setCloneError("");
    setMessages([]);
    setClonedHtml("");
    let targetUrl = url.trim();
    if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl;

    try {
      // Use our own Netlify serverless proxy — no CORS issues!
      const res = await fetch(`/api/proxy?url=${encodeURIComponent(targetUrl)}`);
      const data = await res.json();

      if (!res.ok || data.error) throw new Error(data.error || "Proxy error");
      if (!data.html || data.html.length < 100) throw new Error("Empty response from site");

      const finalUrl = data.finalUrl || targetUrl;
      const processed = makeAbsolute(data.html, finalUrl);

      setClonedHtml(processed);
      setOriginalHtml(processed);
      setMessages([{ role: "assistant", content: `✅ Successfully cloned!\n\nWhat changes would you like to make?` }]);
      setActiveTab("chat");
    } catch (err: any) {
      const msg = err?.message || "Unknown error";
      if (msg.includes("403") || msg.includes("401") || msg.includes("Forbidden")) {
        setCloneError(`"${targetUrl}" blocked the request (403/401). Use Paste instead — open the site → View Source → Copy All → tap Paste.`);
      } else if (msg.includes("timeout") || msg.includes("AbortError")) {
        setCloneError("Request timed out. The site may be slow or unreachable. Try Paste.");
      } else {
        setCloneError(`Could not fetch: ${msg}. Try the Paste button instead.`);
      }
    } finally {
      setCloning(false);
    }
  };

  const handlePaste = async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch {}
    if (!text) text = prompt("Paste your HTML here:") || "";
    if (text.trim().length > 10) {
      setClonedHtml(text.trim());
      setOriginalHtml(text.trim());
      setCloneError("");
      setMessages([{ role: "assistant", content: "✅ HTML loaded! What would you like to change?" }]);
      setActiveTab("chat");
    }
  };

  const handleChat = async () => {
    if (!input.trim() || !clonedHtml || loading) return;
    const userText = input.trim();
    setMessages(prev => [...prev, { role: "user", content: userText }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8000,
          system: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: `Current HTML:\n\`\`\`html\n${clonedHtml}\n\`\`\`\n\nRequest: ${userText}`
          }]
        })
      });
      const data = await res.json();
      const rawText = data.content?.[0]?.text || "";
      let explanation = rawText, newHtml = clonedHtml;
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          explanation = parsed.explanation || rawText;
          if (parsed.html) newHtml = parsed.html;
        }
      } catch {}
      setClonedHtml(newHtml);
      setMessages(prev => [...prev, { role: "assistant", content: explanation }]);
      setActiveTab("preview");
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "❌ AI error — please try again." }]);
    } finally { setLoading(false); }
  };

  const handleSaveGithub = async () => {
    if (!githubToken || !githubRepo || !githubFile || !clonedHtml) return;
    setSaving(true); setSaveStatus("");
    try {
      const [owner, repo] = githubRepo.split("/");
      const contentB64 = btoa(unescape(encodeURIComponent(clonedHtml)));
      let sha: string | undefined;
      try {
        const check = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${githubFile}`, {
          headers: { Authorization: `token ${githubToken}`, Accept: "application/vnd.github.v3+json" }
        });
        if (check.ok) sha = (await check.json()).sha;
      } catch {}
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${githubFile}`, {
        method: "PUT",
        headers: { Authorization: `token ${githubToken}`, "Content-Type": "application/json", Accept: "application/vnd.github.v3+json" },
        body: JSON.stringify({ message: `Update ${githubFile} via WebCloner.ai`, content: contentB64, ...(sha ? { sha } : {}) })
      });
      setSaveStatus(res.ok ? "✅ Saved to GitHub!" : `❌ ${(await res.json()).message}`);
    } catch { setSaveStatus("❌ Failed. Check token & repo."); }
    finally { setSaving(false); }
  };

  const userMsgCount = messages.filter(m => m.role === "user").length;
  const TAB_LABELS = { preview: "👁 Preview", code: "{} Code", chat: `💬 Chat${userMsgCount > 0 ? ` (${userMsgCount})` : ""}` };

  return (
    <div style={{ fontFamily: "'Courier New',monospace", background: "#08090f", color: "#e2e8f0", display: "flex", flexDirection: "column", height: "100dvh", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#0a0c14}::-webkit-scrollbar-thumb{background:#2563eb;border-radius:2px}
        .bp{background:linear-gradient(135deg,#2563eb,#7c3aed);border:none;color:#fff;cursor:pointer;font-family:'Space Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:0 16px;border-radius:6px;transition:all .2s;text-transform:uppercase;white-space:nowrap;height:40px;display:inline-flex;align-items:center;justify-content:center}
        .bp:hover:not(:disabled){opacity:.85;box-shadow:0 4px 16px rgba(59,130,246,.35)}.bp:disabled{opacity:.35;cursor:not-allowed}
        .bg{background:transparent;border:1px solid #1e293b;color:#64748b;cursor:pointer;font-family:'Space Mono',monospace;font-size:11px;padding:0 14px;border-radius:6px;transition:all .2s;text-transform:uppercase;letter-spacing:.05em;height:40px;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
        .bg:hover{border-color:#3b82f6;color:#3b82f6}
        .if{background:#0d1117;border:1px solid #1e293b;border-radius:6px;color:#e2e8f0;font-family:'Space Mono',monospace;font-size:12px;padding:0 12px;outline:none;transition:border-color .2s;height:40px;width:100%}
        .if:focus{border-color:#3b82f6}
        .tab{background:none;border:none;border-bottom:2px solid transparent;color:#475569;cursor:pointer;font-family:'Space Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:0 16px;text-transform:uppercase;transition:all .2s;height:44px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
        .tab.on{color:#60a5fa;border-bottom-color:#3b82f6}.tab:hover:not(.on){color:#94a3b8}
        .mu{align-self:flex-end;max-width:82%;background:linear-gradient(135deg,#1d4ed8,#5b21b6);border-radius:14px 14px 3px 14px;font-size:13px;padding:10px 14px;line-height:1.6;word-break:break-word}
        .ma{align-self:flex-start;max-width:90%;background:#0f172a;border:1px solid #1e3a5f;border-radius:3px 14px 14px 14px;font-size:13px;padding:10px 14px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.15}}.d{animation:blink 1.2s infinite;display:inline-block;font-size:20px;line-height:1}.d:nth-child(2){animation-delay:.2s}.d:nth-child(3){animation-delay:.4s}
        @keyframes fu{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}.mu,.ma{animation:fu .2s ease}
        .chip{background:#0d1117;border:1px solid #1e293b;border-radius:20px;color:#64748b;cursor:pointer;font-family:'Space Mono',monospace;font-size:11px;padding:7px 12px;transition:all .15s;white-space:nowrap}.chip:hover{border-color:#3b82f6;color:#93c5fd}
        .gbg{background-image:linear-gradient(#1e293b15 1px,transparent 1px),linear-gradient(90deg,#1e293b15 1px,transparent 1px);background-size:30px 30px}
      `}</style>

      {/* HEADER */}
      <div style={{ background: "#050508", borderBottom: "1px solid #1a2236", padding: "0 14px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 50, flexShrink: 0, gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div style={{ width: 26, height: 26, background: "linear-gradient(135deg,#3b82f6,#8b5cf6)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>⬡</div>
          <span style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 15, letterSpacing: "-0.02em" }}>
            WEBCLONER<span style={{ color: "#3b82f6" }}>.ai</span>
          </span>
        </div>
        {clonedHtml && (
          <div style={{ display: "flex", gap: 7 }}>
            <button className="bg" style={{ padding: "0 10px" }} title="Revert to original" onClick={() => { setClonedHtml(originalHtml); setMessages(p => [...p, { role: "assistant", content: "↩️ Reverted to original." }]); setActiveTab("preview"); }}>↩</button>
            <button className="bg" style={{ padding: "0 10px" }} title="Download HTML" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([clonedHtml], { type: "text/html" })); a.download = "cloned.html"; a.click(); }}>⬇</button>
            <button className="bp" style={{ padding: "0 12px", fontSize: 10 }} onClick={() => setShowGithub(v => !v)}>⬡ GitHub</button>
          </div>
        )}
      </div>

      {/* GITHUB PANEL */}
      {showGithub && (
        <div style={{ background: "#0a0d14", borderBottom: "1px solid #1e293b", padding: "12px 14px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", flexShrink: 0 }}>
          {([["Token", "ghp_...", githubToken, setGithubToken, "password"], ["Repo", "user/repo", githubRepo, setGithubRepo, "text"], ["File", "index.html", githubFile, setGithubFile, "text"]] as const).map(([label, ph, val, set, type]) => (
            <div key={label} style={{ flex: "1 1 120px", minWidth: 100 }}>
              <div style={{ fontSize: 9, color: "#475569", marginBottom: 5, textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</div>
              <input className="if" type={type} placeholder={ph} value={val} onChange={e => (set as any)(e.target.value)} />
            </div>
          ))}
          <button className="bp" onClick={handleSaveGithub} disabled={saving || !githubToken || !githubRepo}>{saving ? "Pushing…" : "Push →"}</button>
          {saveStatus && <span style={{ fontSize: 11, color: saveStatus.startsWith("✅") ? "#22c55e" : "#f87171", alignSelf: "center" }}>{saveStatus}</span>}
        </div>
      )}

      {/* URL BAR */}
      <div style={{ background: "#060810", borderBottom: "1px solid #151b28", padding: "10px 14px", display: "flex", gap: 8, flexShrink: 0 }}>
        <input className="if" style={{ flex: 1, minWidth: 0 }} placeholder="https://example.com" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && handleClone()} />
        <button className="bp" onClick={handleClone} disabled={cloning || !url.trim()}>{cloning ? "⏳" : "Clone"}</button>
        <button className="bg" onClick={handlePaste}>Paste</button>
      </div>

      {/* ERROR */}
      {cloneError && (
        <div style={{ background: "#190909", borderBottom: "1px solid #7f1d1d", color: "#fca5a5", fontSize: 11, padding: "10px 14px", lineHeight: 1.7, flexShrink: 0 }}>
          ⚠️ {cloneError}
        </div>
      )}

      {/* TABS */}
      <div style={{ display: "flex", borderBottom: "1px solid #1a2236", background: "#050508", flexShrink: 0, paddingLeft: 4 }}>
        {TABS.map(t => (
          <button key={t} className={`tab ${activeTab === t ? "on" : ""}`} onClick={() => setActiveTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>

        {activeTab === "preview" && (
          !clonedHtml
            ? <div className="gbg" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, textAlign: "center", padding: 32 }}>
                <div style={{ fontSize: 44, opacity: 0.15 }}>⬡</div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 17, fontWeight: 700, color: "#334155" }}>No page cloned yet</div>
                <div style={{ fontSize: 12, color: "#1e293b", maxWidth: 240, lineHeight: 1.8 }}>Enter a URL above and tap Clone, or use Paste to load HTML directly.</div>
              </div>
            : <iframe ref={iframeRef} style={{ flex: 1, border: "none", background: "#fff" }} title="preview" sandbox="allow-scripts allow-same-origin" />
        )}

        {activeTab === "code" && (
          <textarea value={clonedHtml} onChange={e => setClonedHtml(e.target.value)} placeholder="No HTML loaded yet."
            style={{ flex: 1, background: "#060b14", color: "#7dd3fc", border: "none", padding: 14, fontFamily: "'Space Mono',monospace", fontSize: 11, lineHeight: 1.7, resize: "none", outline: "none" }} />
        )}

        {activeTab === "chat" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "14px 13px", display: "flex", flexDirection: "column", gap: 10 }}>
              {messages.length === 0 && (
                <div style={{ padding: "8px 0" }}>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 700, color: "#334155", marginBottom: 14, fontSize: 15 }}>AI Page Editor</div>
                  {["1. Clone or paste a webpage", "2. Describe changes in plain English", "3. Preview updates instantly", "4. Push to GitHub when done"].map(s => (
                    <div key={s} style={{ padding: "9px 0", borderBottom: "1px solid #0f172a", color: "#334155", fontSize: 12, lineHeight: 1.6 }}>{s}</div>
                  ))}
                </div>
              )}
              {messages.map((m, i) => <div key={i} className={m.role === "user" ? "mu" : "ma"}>{m.content}</div>)}
              {loading && <div className="ma" style={{ display: "flex", alignItems: "center", gap: 2 }}><span className="d">●</span><span className="d">●</span><span className="d">●</span></div>}
              <div ref={chatEndRef} />
            </div>

            {clonedHtml && userMsgCount === 0 && (
              <div style={{ padding: "8px 12px", display: "flex", gap: 7, flexWrap: "wrap", borderTop: "1px solid #0d1525", background: "#050810" }}>
                {["Dark mode", "Bigger text", "Add animations", "Blue theme", "Remove popups", "Mobile layout"].map(s => (
                  <button key={s} className="chip" onClick={() => setInput(s)}>{s}</button>
                ))}
              </div>
            )}

            <div style={{ padding: "10px 12px", borderTop: "1px solid #1a2236", display: "flex", gap: 8, background: "#05080f", flexShrink: 0 }}>
              <textarea className="if" style={{ flex: 1, resize: "none", height: 66, lineHeight: 1.6, padding: "10px 12px" }}
                placeholder={clonedHtml ? "Describe changes… (Enter to send)" : "Clone a page first…"}
                value={input} disabled={!clonedHtml || loading}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChat(); } }}
              />
              <button className="bp" style={{ alignSelf: "flex-end", height: 40, padding: "0 14px" }}
                onClick={handleChat} disabled={!clonedHtml || loading || !input.trim()}>↑</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
