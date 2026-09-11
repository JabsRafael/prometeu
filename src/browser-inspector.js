(() => {
  window.__prometeuInspector?.dispose();

  const styleNames = [
    "display", "position", "box-sizing", "color", "background-color", "opacity",
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
    "text-align", "width", "height", "padding-top", "padding-right",
    "padding-bottom", "padding-left", "margin-top", "margin-right",
    "margin-bottom", "margin-left", "gap", "align-items", "justify-content",
    "border-top", "border-right", "border-bottom", "border-left", "border-radius",
    "box-shadow", "overflow", "transform",
  ];
  const overlay = document.createElement("div");
  overlay.setAttribute("data-prometeu-inspector", "");
  overlay.setAttribute("aria-hidden", "true");
  for (const [name, value] of Object.entries({
    all: "initial", position: "fixed", "pointer-events": "none",
    "z-index": "2147483647", "box-sizing": "border-box",
    border: "2px solid #6786ff", background: "rgba(103, 134, 255, 0.14)",
  })) overlay.style.setProperty(name, value, "important");

  let enabled = false;
  let selection = null;
  let captured = null;
  let pointer = null;

  function truncate(value, limit) {
    const result = value.slice(0, limit);
    // A dangling high surrogate cannot cross the JSON boundary into Rust.
    return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
  }

  function selectorFor(element) {
    const parts = [];
    const root = element.getRootNode();
    for (let node = element; node; node = node.parentElement) {
      if (node.id && root.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName) index++;
      }
      parts.unshift(`${CSS.escape(node.localName)}:nth-of-type(${index})`);
    }
    const local = parts.join(" > ");
    // Open shadow roots use an explicit host boundary, not a single CSS selector.
    return root instanceof ShadowRoot ? `${selectorFor(root.host)} >>> ${local}` : local;
  }

  function capture(element) {
    const clone = element.cloneNode(true);
    const omitted = "script, style, link, meta, iframe, object, embed, noscript, template, [data-prometeu-inspector]";
    clone.querySelectorAll(omitted).forEach((node) => node.remove());
    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.replace(/[\s\u0000-\u001f]/g, "");
        if (name.startsWith("on") || name === "srcdoc" || name === "value"
          || name === "checked" || name === "selected" || name === "nonce"
          || /^(javascript|vbscript):/i.test(value) || /^data:text\/html/i.test(value)) {
          node.removeAttribute(attribute.name);
        }
      }
      if (node.localName === "textarea") node.textContent = "";
    }
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const html = clone.matches(omitted) ? "" : clone.outerHTML;
    return {
      url: truncate(location.href, 4096),
      selector: truncate(selectorFor(element), 1000),
      tag: element.localName,
      text: truncate((html ? clone.textContent || "" : "").trim(), 2000),
      html: truncate(html, 12000),
      styles: Object.fromEntries(styleNames.map((name) => [name, truncate(computed.getPropertyValue(name), 1000)])),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
    };
  }

  function highlight(element) {
    if (!element || element === overlay || !element.isConnected) {
      overlay.remove();
      return;
    }
    const rect = element.getBoundingClientRect();
    for (const [name, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })) {
      overlay.style.setProperty(name, `${value}px`, "important");
    }
    if (!overlay.isConnected) document.documentElement.append(overlay);
  }

  function refresh() {
    if (!enabled || !pointer) return;
    let element = document.elementFromPoint(pointer.x, pointer.y);
    // Frame contents require separate injection and are deliberately outside this inspector.
    while (element?.shadowRoot?.elementFromPoint) {
      const child = element.shadowRoot.elementFromPoint(pointer.x, pointer.y);
      if (!child || child === element) break;
      element = child;
    }
    highlight(element);
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    pointer = null;
    overlay.remove();
    if (enabled) selection = captured = null;
  }

  function move(event) {
    if (!enabled) return;
    pointer = { x: event.clientX, y: event.clientY };
    highlight(event.composedPath().find((node) => node instanceof Element));
  }

  function block(event) {
    if (!enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function click(event) {
    if (!enabled) return;
    block(event);
    const element = event.composedPath().find((node) => node instanceof Element);
    if (element && element !== overlay) {
      selection = capture(element);
      captured = { element, data: selection };
    }
    setEnabled(false);
  }

  function key(event) {
    if (enabled && event.key === "Escape") {
      block(event);
      selection = captured = null;
      setEnabled(false);
    }
  }

  function leave(event) {
    if (!event.relatedTarget) {
      pointer = null;
      overlay.remove();
    }
  }

  function changed() {
    captured = null;
    refresh();
  }

  const listeners = {
    pointermove: move, pointerdown: block, pointerup: block,
    mousedown: block, mouseup: block, click, keydown: key,
    pointerout: leave, scroll: changed, resize: changed,
  };
  for (const [name, listener] of Object.entries(listeners)) window.addEventListener(name, listener, true);
  window.__prometeuInspector = {
    get enabled() { return enabled; },
    setEnabled,
    takeSelection() {
      const result = selection;
      selection = null;
      return result;
    },
    selectionCurrent() {
      if (!captured || !captured.element.isConnected) return false;
      const { element, data } = captured;
      if (location.href !== data.url || innerWidth !== data.viewport.width || innerHeight !== data.viewport.height) return false;
      const rect = element.getBoundingClientRect();
      return ["x", "y", "width", "height"].every((key) => rect[key] === data.rect[key]);
    },
    dispose() {
      setEnabled(false);
      selection = captured = null;
      for (const [name, listener] of Object.entries(listeners)) window.removeEventListener(name, listener, true);
    },
  };
})();
