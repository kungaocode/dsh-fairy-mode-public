/**
 * Offline smoke test for the DSH client half of dsh-fairy-mode.
 *
 * Executes the browser bundle exactly the way the shell does:
 *   window.__ModuleLoader__.load({ id, factory })   → factory(require) → apply(ctx)
 *
 * The DOM, React and the slot registry are stubs, so this proves only that the
 * module registers under the right id, its factory evaluates, and `apply()`
 * tolerates the slot/registration API it is given. It is not a render test.
 *
 *   node scripts/client-smoke.mjs [bundle] [expected module id]
 *
 * Defaults resolve against this package, and the expected id is the package
 * name from package.json — the boot graph keys client rows by package name, so
 * a mismatch there is exactly the failure this test exists to catch.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = fileURLToPath(new URL('.', import.meta.url))
const manifest = JSON.parse(readFileSync(`${here}../package.json`, 'utf8'))
const file = process.argv[2] || `${here}../client.js`
const expectedId = process.argv[3] || manifest.name
const source = readFileSync(file, 'utf8')

const warnings = []
const errors = []

/* ---------------------------------------------------------------- DOM stubs */
function makeElement(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    style: {
      setProperty(name, value) { this[name] = value },
      removeProperty(name) { delete this[name] },
    },
    dataset: {},
    className: '',
    textContent: '',
    innerHTML: '',
    children: [],
    parentNode: null,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)) },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null },
    hasAttribute(name) { return this.attributes.has(name) },
    removeAttribute(name) { this.attributes.delete(name) },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child },
    insertBefore(child) { this.children.push(child); child.parentNode = this; return child },
    remove() { this.parentNode?.removeChild?.(this) },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
    focus() {},
    blur() {},
    click() {},
    play() { return Promise.resolve() },
    pause() {},
    load() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 } },
    closest() { return null },
    contains() { return false },
  }
  // Any other property the bundle reaches for resolves to a no-op function or
  // an empty object instead of exploding the smoke test.
  return new Proxy(element, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prodOnlyProps.has(prop)) return target[prop]
      if (typeof prop === 'symbol') return undefined
      return () => {}
    },
    set(target, prop, value) { target[prop] = value; return true },
  })
}
const prodOnlyProps = new Set()

function makeDocument() {
  const head = makeElement('head')
  const body = makeElement('body')
  const documentElement = makeElement('html')
  const listeners = new Map()
  const doc = {
    head,
    body,
    documentElement,
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]) },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    execCommand: () => true,
    createTreeWalker: () => ({ nextNode: () => null }),
  }
  return doc
}

const document = makeDocument()

/* ------------------------------------------------------------------ React */
function makeReact() {
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ $$typeof: 'element', type, props: props || {}, children }),
    createRef: () => ({ current: null }),
    forwardRef: (fn) => fn,
    memo: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useReducer: (reducer, initial) => [initial, () => {}],
    useContext: () => undefined,
    useId: () => 'react-id',
    Children: { map: (items) => items, toArray: (items) => items, only: (item) => item },
  }
  return React
}

const requireCalls = []
function fakeRequire(name) {
  requireCalls.push(name)
  if (name === 'react') return makeReact()
  if (name === 'react/jsx-runtime') {
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('Fragment') }
  }
  throw new Error(`client bundle required an unexpected module: ${name}`)
}

/* -------------------------------------------------------------- the runner */
let registration = null
const context = {
  console: {
    log: (...a) => console.log('[client log]', ...a),
    warn: (...a) => { warnings.push(a.map(String).join(' ')); console.warn('[client warn]', ...a) },
    error: (...a) => { errors.push(a.map(String).join(' ')); console.error('[client error]', ...a) },
    info: () => {},
    debug: () => {},
    group: () => {},
    groupEnd: () => {},
  },
  window: {
    __ModuleLoader__: { load: (entry) => { registration = entry } },
    document,
    performance: { now: () => 0 },
    setTimeout: (fn) => { try { if (typeof fn === 'function') fn() } catch (error) { errors.push(String(error)) } return 1 },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { try { fn(0) } catch (error) { errors.push(String(error)) } return 1 },
    cancelAnimationFrame: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
    location: { href: 'http://127.0.0.1:19401/', origin: 'http://127.0.0.1:19401', host: '127.0.0.1:19401', pathname: '/' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { language: 'zh-CN', languages: ['zh-CN'], userAgent: 'smoke' },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  },
  document,
  navigator: { language: 'zh-CN', languages: ['zh-CN'], userAgent: 'smoke', clipboard: { writeText: () => Promise.resolve() } },
  performance: { now: () => 0 },
  fetch: (url) => {
    fetched.push(String(url))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve(''), blob: () => Promise.resolve({}) })
  },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
  IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  Audio: class { constructor() { this.play = () => Promise.resolve(); this.pause = () => {} } addEventListener() {} removeEventListener() {} },
  URL,
  URLSearchParams,
  AbortController,
  AbortSignal,
  Event: class { constructor(type) { this.type = type } },
  CustomEvent: class { constructor(type) { this.type = type } },
  HTMLElement: class {},
  HTMLVideoElement: class {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => { try { fn(0) } catch (error) { errors.push(String(error)) } return 1 },
  setTimeout: (fn) => { try { if (typeof fn === 'function') fn() } catch (error) { errors.push(String(error)) } return 1 },
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  console,
}
context.window.window = context.window
context.window.document = document
context.globalThis = context
context.self = context.window
const fetched = []

vm.createContext(context)
try {
  vm.runInContext(source, context, { filename: file })
} catch (error) {
  console.error('FAIL: bundle threw while evaluating:', error)
  process.exit(1)
}

if (!registration) {
  console.error('FAIL: bundle never called window.__ModuleLoader__.load()')
  process.exit(1)
}
if (registration.id !== expectedId) {
  console.error(`FAIL: module id is ${JSON.stringify(registration.id)}, expected ${JSON.stringify(expectedId)} (the boot graph keys rows by package name)`)
  process.exit(1)
}

let exportsObject
try {
  exportsObject = registration.factory(fakeRequire)
} catch (error) {
  console.error('FAIL: factory threw:', error)
  process.exit(1)
}

const slots = []
const activeSlots = new Set()
const disposers = []
const ctx = {
  effect(fn, label) {
    try {
      const result = fn()
      if (typeof result === 'function') disposers.push([label, result])
      return result
    } catch (error) {
      errors.push(`effect ${label}: ${error && error.message}`)
      console.error(`[effect error] ${label}:`, error)
      return undefined
    }
  },
  on() { return () => {} },
  emit() {},
  get() { return undefined },
  logger: { warn: (...a) => warnings.push(a.join(' ')), info: () => {}, error: (...a) => errors.push(a.join(' ')) },
  slots: {
    inject(name, callback) {
      try { callback() } catch (error) { errors.push(`slots.inject(${name}): ${error && error.message}`); throw error }
      return () => {}
    },
    register(options, component) {
      const slot = { name: options.name, id: options.id, order: options.order, priority: options.priority, label: options.label, component }
      slots.push(slot)
      activeSlots.add(slot)
      return () => activeSlots.delete(slot)
    },
  },
  settings: { get: () => undefined, set: () => {} },
  connection: { call: () => Promise.resolve({}) },
}

try {
  exportsObject.apply(ctx)
} catch (error) {
  console.error('FAIL: apply() threw:', error)
  process.exit(1)
}

// Components must survive one render with the hook stubs above.
const React = makeReact()
let rendered = 0
for (const slot of slots) {
  try {
    const element = slot.component({ renderSlot: () => null, owner: {}, hooks: {}, t: (key) => key })
    if (element && typeof element === 'object') rendered += 1
  } catch (error) {
    errors.push(`render ${slot.name}/${slot.id || '(single)'}: ${error && error.message}`)
  }
}

// Drive the real mode button: removing the skin must also remove composer
// contributions, without losing the only control that can restore the mode.
const initialSlots = slots.slice()
let modeTransitions = null
try {
  const pill = [...activeSlots].find((slot) => slot.id === 'hdd-pill')
  const toggle = () => pill.component({}).props.onClick()
  const countComposer = () => [...activeSlots].filter((slot) => slot.name === 'conversation.input.right').length
  const styleHost = [...activeSlots].find((slot) => slot.id === 'hdd-style-host').component({})
  const persistentCss = styleHost.children.join('')
  if (persistentCss.includes('--dsh-composer-model-text-display') || persistentCss.includes('[data-hdd-voice]')) {
    throw new Error('mode-only stylesheet still overrides the native composer')
  }
  const before = countComposer()
  toggle()
  const off = countComposer()
  if (off !== 0) throw new Error('HDD off left plugin controls in the composer')
  if (document.head.children.some((element) => element.hasAttribute('data-hdd-skin'))) throw new Error('HDD off left its skin stylesheet mounted')
  if (![...activeSlots].some((slot) => slot.id === 'hdd-mode-fallback')) throw new Error('HDD off lost its persistent switch')
  if ([...activeSlots].some((slot) => slot.id === 'hdd-search-panel')) throw new Error('HDD off left the search panel mounted')
  toggle()
  const restored = countComposer()
  if (before !== 5 || restored !== before) throw new Error('HDD on failed to restore exactly five composer controls')
  modeTransitions = { before, off, restored }
} catch (error) { errors.push(`mode transitions: ${error.message}`) }

console.log(JSON.stringify({
  id: registration.id,
  exports: Object.keys(exportsObject),
  inject: exportsObject.inject,
  requires: requireCalls,
  slots: initialSlots.map((slot) => ({ name: slot.name, id: slot.id ?? null, priority: slot.priority ?? null })),
  modeTransitions,
  rendered,
  disposers: disposers.length,
  warnings: warnings.slice(0, 8),
  errors: errors.slice(0, 8),
  fetched: [...new Set(fetched)].slice(0, 8),
}, null, 2))

if (errors.length > 0) process.exit(2)
