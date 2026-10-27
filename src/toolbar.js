export function createToolbar(doc) {
  const host = doc.createElement('div');
  host.dataset.ctOwned = 'toolbar';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed!important;right:20px;bottom:20px;z-index:2147483647!important;color-scheme:light dark;font:13px/1.5 system-ui,sans-serif}
    *{box-sizing:border-box}
    .panel{width:320px;max-width:calc(100vw - 16px);border:1px solid #42566b;border-radius:14px;padding:14px;background:#102230;color:#edf5f8;box-shadow:0 8px 35px #0005}
    .panel.collapsed{width:192px}
    .header{display:flex;align-items:center;gap:8px}
    #drag{flex:1;min-width:0;padding:3px 0;cursor:grab;touch-action:none;user-select:none;font-weight:bold;font-size:15px}
    #drag:active{cursor:grabbing}
    #drag:focus-visible{outline:2px solid #8de1d0;border-radius:4px}
    p{margin:8px 0;overflow-wrap:anywhere;color:#b9d8dd}
    .buttons{display:flex;gap:6px;flex-wrap:wrap}
    button{border:1px solid #546b78;border-radius:7px;background:#203c4b;color:#fff;padding:5px 9px;cursor:pointer;font:inherit}
    button:hover{background:#365766}button:focus-visible{outline:2px solid #8de1d0}
    #collapse{padding:3px 7px;font-size:12px}
    .hint{font-size:11px;color:#93b0b8;margin-bottom:0}[hidden]{display:none!important}
  </style><div class="panel"><div class="header"><div id="drag" tabindex="0" role="group" aria-label="移动全文伴读浮窗，可拖动或使用方向键" title="拖动移动，也可聚焦后使用方向键">全文伴读</div><button id="collapse" aria-expanded="true" aria-controls="details">折叠</button></div><div id="details"><p id="status" role="status" aria-live="polite">准备翻译…</p><div class="buttons"><button id="start">翻译全文</button><button id="stop">停止</button><button id="toggle">隐藏译文</button><button id="retry">重试失败</button></div><p class="hint">启动后自动补译新正文 · 原文始终保留</p></div></div>`;
  const win = doc.defaultView, panel = shadow.querySelector('.panel');
  const handle = shadow.getElementById('drag'), toggle = shadow.getElementById('collapse');
  let dragging;
  function move(x, y) {
    const rect = host.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, win.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, win.innerHeight - rect.height - 8));
    for (const [name, value] of Object.entries({ left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' })) host.style.setProperty(name, value, 'important');
  }
  function clamp() {
    if (!host.isConnected) return;
    const r = host.getBoundingClientRect();
    move(r.left, r.top);
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const r = host.getBoundingClientRect();
    dragging = { id: event.pointerId, dx: event.clientX - r.left, dy: event.clientY - r.top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (dragging?.id === event.pointerId) move(event.clientX - dragging.dx, event.clientY - dragging.dy);
  });
  const release = event => {
    if (dragging?.id !== event.pointerId) return;
    dragging = null;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  handle.addEventListener('lostpointercapture', () => { dragging = null; });
  handle.addEventListener('keydown', event => {
    const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const r = host.getBoundingClientRect();
    move(r.left + delta[0], r.top + delta[1]);
  });
  toggle.onclick = () => {
    const collapsed = panel.classList.toggle('collapsed');
    shadow.getElementById('details').hidden = collapsed;
    toggle.textContent = collapsed ? '展开' : '折叠';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    clamp();
  };
  win.addEventListener('resize', clamp);
  return { host, shadow, clamp };
}
