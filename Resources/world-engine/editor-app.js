import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

const CURRENT_WORLD_SCHEMA_VERSION = 1;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function validateVector3(value, path) {
  if (!isObject(value)) {
    return [`${path} must be an object with x, y, and z numbers`];
  }
  const errors = [];
  ['x', 'y', 'z'].forEach((key) => {
    if (!isFiniteNumber(value[key])) {
      errors.push(`${path}.${key} must be a finite number`);
    }
  });
  return errors;
}

function validateQuaternion(value, path) {
  if (!isObject(value)) {
    return [`${path} must be an object with x, y, z, and w numbers`];
  }
  const errors = [];
  ['x', 'y', 'z', 'w'].forEach((key) => {
    if (!isFiniteNumber(value[key])) {
      errors.push(`${path}.${key} must be a finite number`);
    }
  });
  return errors;
}

function validateTransform(value, path) {
  if (!isObject(value)) {
    return [`${path} must be an object`];
  }
  let errors = [];
  if ('position' in value) errors = errors.concat(validateVector3(value.position, `${path}.position`));
  if ('rotation' in value) errors = errors.concat(validateQuaternion(value.rotation, `${path}.rotation`));
  if ('scale' in value) errors = errors.concat(validateVector3(value.scale, `${path}.scale`));
  return errors;
}

function validateComponent(component, path) {
  if (!isObject(component)) {
    return [`${path} must be an object`];
  }
  const errors = [];
  if (typeof component.type !== 'string' || !component.type.trim()) {
    errors.push(`${path}.type must be a non-empty string`);
  }
  if ('data' in component && !isObject(component.data)) {
    errors.push(`${path}.data must be an object when present`);
  }
  return errors;
}

function validateNodeAssetReference(assetRef, path, assets = []) {
  if (!isObject(assetRef)) {
    return [`${path} must be an object`];
  }
  const errors = [];
  if (typeof assetRef.assetId !== 'string' || !assetRef.assetId.trim()) {
    errors.push(`${path}.assetId must be a non-empty string`);
  } else if (!assets.find((asset) => asset.id === assetRef.assetId)) {
    errors.push(`${path}.assetId references missing asset '${assetRef.assetId}'`);
  }
  if ('options' in assetRef && !isObject(assetRef.options)) {
    errors.push(`${path}.options must be an object when present`);
  }
  return errors;
}

function validateSceneNode(node, path, context) {
  if (!isObject(node)) {
    return [`${path} must be an object`];
  }
  const errors = [];
  if (typeof node.id !== 'string' || !node.id.trim()) {
    errors.push(`${path}.id must be a non-empty string`);
  } else if (context.seenIds.has(node.id)) {
    errors.push(`${path}.id '${node.id}' must be unique`);
  } else {
    context.seenIds.add(node.id);
  }

  if ('name' in node && typeof node.name !== 'string') {
    errors.push(`${path}.name must be a string when present`);
  }
  if ('tags' in node) {
    if (!Array.isArray(node.tags) || node.tags.some((tag) => typeof tag !== 'string')) {
      errors.push(`${path}.tags must be an array of strings when present`);
    }
  }
  if ('transform' in node) {
    errors.push(...validateTransform(node.transform, `${path}.transform`));
  }
  if ('components' in node) {
    if (!Array.isArray(node.components)) {
      errors.push(`${path}.components must be an array when present`);
    } else {
      node.components.forEach((component, index) => {
        errors.push(...validateComponent(component, `${path}.components[${index}]`));
      });
    }
  }
  if ('asset' in node) {
    errors.push(...validateNodeAssetReference(node.asset, `${path}.asset`, context.assets));
  }
  if ('children' in node) {
    if (!Array.isArray(node.children)) {
      errors.push(`${path}.children must be an array when present`);
    } else {
      node.children.forEach((child, index) => {
        errors.push(...validateSceneNode(child, `${path}.children[${index}]`, context));
      });
    }
  }
  return errors;
}

function validateAssets(assets, path) {
  if (assets === undefined) return { errors: [] };
  if (!Array.isArray(assets)) return { errors: [`${path} must be an array when present`] };
  const seenIds = new Set();
  const errors = [];
  assets.forEach((asset, index) => {
    const assetPath = `${path}[${index}]`;
    if (!isObject(asset)) {
      errors.push(`${assetPath} must be an object`);
      return;
    }
    if (typeof asset.id !== 'string' || !asset.id.trim()) {
      errors.push(`${assetPath}.id must be a non-empty string`);
    } else if (seenIds.has(asset.id)) {
      errors.push(`${assetPath}.id '${asset.id}' must be unique`);
    } else {
      seenIds.add(asset.id);
    }
    if (typeof asset.uri !== 'string' || !asset.uri.trim()) {
      errors.push(`${assetPath}.uri must be a non-empty string`);
    }
    if (asset.type && typeof asset.type !== 'string') {
      errors.push(`${assetPath}.type must be a string when present`);
    }
  });
  return { errors, assetList: assets };
}

export function validateWorldDocument(world) {
  const errors = [];
  if (!isObject(world)) return { valid: false, errors: ['World must be an object'] };
  const { errors: assetErrors, assetList } = validateAssets(world.assets, 'assets');
  errors.push(...assetErrors);
  if (!Array.isArray(world.nodes)) {
    errors.push('nodes must be an array');
  } else {
    const seenIds = new Set();
    world.nodes.forEach((node, index) => errors.push(...validateSceneNode(node, `nodes[${index}]`, { assets: assetList, seenIds })));
  }
  return { valid: errors.length === 0, errors };
}

export function serializeWorld(world) {
  const validation = validateWorldDocument(world);
  if (!validation.valid) throw new Error(`World document is invalid: ${validation.errors.join('; ')}`);
  return JSON.stringify({ ...world, version: CURRENT_WORLD_SCHEMA_VERSION }, null, 2);
}

export function deserializeWorld(serialized) {
  const parsed = JSON.parse(serialized);
  if (parsed.version === undefined) parsed.version = 0;
  if (parsed.version > CURRENT_WORLD_SCHEMA_VERSION) {
    throw new Error(`Cannot load future schema version ${parsed.version}`);
  }
  const validation = validateWorldDocument(parsed);
  if (!validation.valid) throw new Error(`World document is invalid: ${validation.errors.join('; ')}`);
  return { ...parsed, version: CURRENT_WORLD_SCHEMA_VERSION };
}

const DEFAULT_WORLD = {
  version: 1,
  metadata: {
    title: 'Demo Park',
    author: 'World Engine',
    description: 'Sample scene showcasing the authoring pipeline.',
  },
  assets: [
    { id: 'hero-tree', uri: '/assets/tree.gltf', type: 'gltf', meta: { variant: 'pine' } },
    { id: 'campfire-audio', uri: '/assets/campfire.ogg', type: 'audio' },
  ],
  nodes: [
    {
      id: 'root',
      name: 'World root',
      tags: ['scene'],
      children: [
        {
          id: 'camp',
          name: 'Camp clearing',
          transform: { position: { x: 2, y: 0, z: -3 } },
          components: [{ type: 'light', data: { intensity: 1.2 } }],
          children: [
            {
              id: 'fire',
              name: 'Campfire',
              asset: { assetId: 'campfire-audio' },
              components: [{ type: 'emitter', data: { rate: 32 } }],
            },
          ],
        },
        {
          id: 'trees',
          name: 'Tree cluster',
          tags: ['foliage'],
          children: [
            {
              id: 'tree-1',
              name: 'Tree A',
              asset: { assetId: 'hero-tree' },
              transform: { position: { x: -4, y: 0, z: 2 } },
            },
            {
              id: 'tree-2',
              name: 'Tree B',
              asset: { assetId: 'hero-tree' },
              transform: { position: { x: -6, y: 0, z: 4 } },
            },
          ],
        },
      ],
    },
  ],
};

class ModeManager {
  constructor(options, initialMode = 'edit') {
    this.options = options;
    this.mode = initialMode;
    this.contexts = new Map();
    this.listeners = new Set();
    this.dirty = false;
    const context = this.createOrGetContext(initialMode);
    context.activate?.();
  }
  getMode() {
    return this.mode;
  }
  isDirty() {
    return this.options.hasUnsavedChanges?.() ?? this.dirty;
  }
  markDirty() {
    this.dirty = true;
  }
  clearDirty() {
    this.dirty = false;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.mode);
    return () => this.listeners.delete(listener);
  }
  getContext(mode) {
    return this.contexts.get(mode);
  }
  async switchMode(target) {
    if (target === this.mode) return true;
    const previous = this.contexts.get(this.mode);
    const next = this.createOrGetContext(target);
    const canSwitch = await this.handleUnsavedChanges(target);
    if (!canSwitch) return false;
    previous?.deactivate?.();
    next.activate?.();
    this.mode = target;
    this.listeners.forEach((listener) => listener(this.mode));
    return true;
  }
  destroy() {
    this.createOrGetContext('edit');
    this.createOrGetContext('play');
    this.contexts.forEach((context) => context.dispose?.());
    this.contexts.clear();
    this.listeners.clear();
  }
  createOrGetContext(mode) {
    const existing = this.contexts.get(mode);
    if (existing) return existing;
    const context = this.options.createContext(mode);
    this.contexts.set(mode, context);
    return context;
  }
  async handleUnsavedChanges(target) {
    if (!this.isDirty()) return true;
    if (this.options.autoSave) {
      await this.options.autoSave();
      this.clearDirty();
      return true;
    }
    if (this.options.confirmSwitch) {
      const ok = await this.options.confirmSwitch(this.mode, target);
      if (ok) this.clearDirty();
      return ok;
    }
    return true;
  }
}

class SelectionManager {
  constructor(initialSelection = []) {
    this.selection = new Set(initialSelection);
    this.focused = [...this.selection][0];
  }
  getSelection() {
    return [...this.selection];
  }
  getFocused() {
    return this.focused;
  }
  isSelected(id) {
    return this.selection.has(id);
  }
  isFocused(id) {
    return this.focused === id;
  }
  setSelection(ids, focusLast = true) {
    const next = Array.from(ids);
    this.selection = new Set(next);
    if (focusLast) {
      this.focused = next[next.length - 1];
    } else if (this.focused && !this.selection.has(this.focused)) {
      this.focused = next[0];
    }
    return this.getSelection();
  }
  select(id, options = {}) {
    const { additive = false, focus = true } = options;
    if (!additive) this.selection.clear();
    if (additive && this.selection.has(id)) {
      this.selection.delete(id);
    } else {
      this.selection.add(id);
    }
    if (focus) {
      this.focused = id;
    } else if (this.focused && !this.selection.has(this.focused)) {
      this.focused = this.selection.values().next().value;
    }
    return this.getSelection();
  }
  focus(id) {
    if (id && this.selection.has(id)) {
      this.focused = id;
    } else if (id) {
      this.selection = new Set([id]);
      this.focused = id;
    } else {
      this.focused = this.selection.values().next().value;
    }
    return this.focused;
  }
  focusNext(order, direction = 1) {
    if (order.length === 0) {
      this.focused = undefined;
      this.selection.clear();
      return undefined;
    }
    const currentIndex = this.focused ? order.indexOf(this.focused) : -1;
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + order.length) % order.length;
    const nextId = order[nextIndex];
    this.selection = new Set([nextId]);
    this.focused = nextId;
    return nextId;
  }
  ensureFocused() {
    if (this.focused && this.selection.has(this.focused)) return this.focused;
    const [first] = this.selection;
    this.focused = first;
    return this.focused;
  }
}

const findNodeById = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const child = findNodeById(node.children, id);
      if (child) return child;
    }
  }
  return undefined;
};

const updateNodeById = (nodes, id, updater) => {
  let changed = false;
  const mapped = nodes.map((node) => {
    let nextNode = node;
    if (node.id === id) {
      nextNode = updater(node) ?? node;
      changed = changed || nextNode !== node;
    }
    let children = node.children;
    if (node.children) {
      const { nodes: nextChildren, changed: childChanged } = updateNodeById(node.children, id, updater);
      children = nextChildren;
      changed = changed || childChanged;
    }
    if (node.children !== children || nextNode !== node) {
      nextNode = { ...nextNode, children };
    }
    return nextNode;
  });
  return { nodes: changed ? mapped : nodes, changed };
};

const flattenNodeIds = (nodes) => nodes.flatMap((node) => [node.id, ...(node.children ? flattenNodeIds(node.children) : [])]);

const ModeToggle = ({ manager, onCancel }) => {
  const [mode, setMode] = useState(manager.getMode());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => manager.subscribe(setMode), [manager]);

  const toggle = async () => {
    setBusy(true);
    setError('');
    const target = mode === 'play' ? 'edit' : 'play';
    try {
      const switched = await manager.switchMode(target);
      if (!switched) {
        setError('Switch canceled — save or confirm to continue.');
        onCancel?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mode-toggle" aria-live="polite">
      <div className={`mode-indicator is-${mode}`}>
        <span className="dot" aria-hidden />
        <span className="label">{mode === 'play' ? 'Simulating' : 'Editing'}</span>
      </div>
      <button className={`button ${mode === 'play' ? 'danger' : 'primary'}`} onClick={toggle} disabled={busy}>
        {mode === 'play' ? 'Stop' : 'Play'}
      </button>
      {error && <span className="mode-warning">{error}</span>}
    </div>
  );
};

const WorldIoMenu = ({ onExport, onImport }) => {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = React.useRef(null);
  const exportLabel = useMemo(() => (busy ? 'Exporting…' : 'Export world'), [busy]);

  const triggerImport = () => {
    setError('');
    fileInputRef.current?.click();
  };

  const handleExport = async () => {
    setBusy(true);
    setError('');
    setStatus('Preparing export…');
    try {
      const pkg = await onExport();
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'world.json';
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(`Export complete (hash ${pkg.hash})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('Export failed');
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = async (event) => {
    const [file] = Array.from(event.target.files ?? []);
    if (!file) return;
    setBusy(true);
    setError('');
    setStatus(`Importing ${file.name}…`);
    try {
      const payload = await file.text();
      await onImport(payload);
      setStatus(`Imported ${file.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('Import failed');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="world-io-menu">
      <div className="controls">
        <button className="button" onClick={triggerImport} disabled={busy} aria-live="polite">
          Import world
        </button>
        <button className="button primary" onClick={handleExport} disabled={busy} aria-live="polite">
          {exportLabel}
        </button>
        <input type="file" accept="application/json" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileChange} />
      </div>
      <div className="status" role="status" aria-live="polite">
        {status}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
};

const HierarchyPanel = ({ nodes, selection, onSelectionChange, onFocusRequest }) => {
  const [expanded, setExpanded] = useState(() => new Set(flattenNodeIds(nodes)));
  const orderedIds = useMemo(() => flattenNodeIds(nodes), [nodes]);

  const toggleExpanded = (id) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleSelect = (id, additive) => {
    selection.select(id, { additive, focus: true });
    onSelectionChange?.(selection.getSelection());
  };

  const handleFocus = (id) => {
    selection.focus(id);
    onFocusRequest?.(id);
    onSelectionChange?.(selection.getSelection());
  };

  const handleKeyboardFocus = (direction) => {
    selection.focusNext(orderedIds, direction);
    const focused = selection.getFocused();
    if (focused) {
      onFocusRequest?.(focused);
      onSelectionChange?.(selection.getSelection());
    }
  };

  return (
    <section className="editor-panel hierarchy-panel">
      <header className="panel-header">
        <div>
          <div className="panel-title">Hierarchy</div>
          <div className="panel-subtitle">Navigate and focus nodes</div>
        </div>
        <div className="panel-actions">
          <button className="ghost" onClick={() => handleKeyboardFocus(-1)} title="Focus previous (Alt+Up)">
            ↑
          </button>
          <button className="ghost" onClick={() => handleKeyboardFocus(1)} title="Focus next (Alt+Down)">
            ↓
          </button>
        </div>
      </header>
      <div className="panel-body hierarchy-list" role="tree" aria-label="Scene hierarchy">
        {nodes.map((node) => (
          <HierarchyNode
            key={node.id}
            node={node}
            depth={0}
            expanded={expanded}
            selection={selection}
            onSelect={handleSelect}
            onFocus={handleFocus}
            toggleExpanded={toggleExpanded}
          />
        ))}
      </div>
    </section>
  );
};

const HierarchyNode = ({ node, depth, expanded, selection, toggleExpanded, onSelect, onFocus }) => {
  const hasChildren = Boolean(node.children?.length);
  const isExpanded = expanded.has(node.id);
  const selected = selection.isSelected(node.id);
  const focused = selection.isFocused(node.id);
  return (
    <div
      className={`hierarchy-node${selected ? ' is-selected' : ''}${focused ? ' is-focused' : ''}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect(node.id, event.metaKey || event.ctrlKey || event.shiftKey);
        if (event.key === ' ') onFocus(node.id);
      }}
    >
      <div className="hierarchy-node__content" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button className="ghost toggle" onClick={() => toggleExpanded(node.id)} aria-label="Toggle children">
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="ghost toggle placeholder" />
        )}
        <button
          className="ghost label"
          onClick={(event) => onSelect(node.id, event.metaKey || event.ctrlKey || event.shiftKey)}
          onDoubleClick={() => onFocus(node.id)}
        >
          <span className="node-name">{node.name ?? node.id}</span>
        </button>
        <div className="node-tags" aria-hidden>
          {node.tags?.join(', ')}
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div className="hierarchy-children" role="group">
          {node.children.map((child) => (
            <HierarchyNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selection={selection}
              toggleExpanded={toggleExpanded}
              onSelect={onSelect}
              onFocus={onFocus}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const VectorFields = ({ label, value = { x: 0, y: 0, z: 0 }, axes = ['x', 'y', 'z'], onChange }) => (
  <div className="field">
    <label className="field-label">{label}</label>
    <div className="field-grid">
      {axes.map((axis) => (
        <input
          key={axis}
          type="number"
          step="0.1"
          value={Number(value?.[axis] ?? 0)}
          onChange={(event) => onChange(axis, Number(event.target.value) || 0)}
          aria-label={`${label} ${axis}`}
        />
      ))}
    </div>
  </div>
);

const InspectorPanel = ({ world, selection, onUpdateNode }) => {
  const selectedId = selection.getFocused();
  const node = selectedId ? findNodeById(world.nodes, selectedId) : undefined;

  const updateNode = (updater) => {
    if (!node) return;
    onUpdateNode(node.id, updater);
  };

  if (!node) return <section className="editor-panel inspector-panel"><div className="inspector-empty">Select a node to edit its properties.</div></section>;

  const transform = node.transform ?? {};

  return (
    <section className="editor-panel inspector-panel">
      <header className="panel-header">
        <div>
          <div className="panel-title">Inspector</div>
          <div className="panel-subtitle">Editing {node.name ?? node.id}</div>
        </div>
      </header>
      <div className="panel-body inspector-fields">
        <div className="field">
          <label className="field-label" htmlFor="node_name">
            Name
          </label>
          <input
            id="node_name"
            type="text"
            value={node.name ?? ''}
            onChange={(event) => updateNode((current) => ({ ...current, name: event.target.value }))}
          />
        </div>

        <VectorFields
          label="Position"
          value={transform.position}
          onChange={(axis, value) =>
            updateNode((current) => ({
              ...current,
              transform: { ...current.transform, position: { ...(current.transform?.position ?? { x: 0, y: 0, z: 0 }), [axis]: value } },
            }))
          }
        />

        <VectorFields
          label="Rotation (quat)"
          value={transform.rotation ?? { x: 0, y: 0, z: 0, w: 1 }}
          axes={['x', 'y', 'z', 'w']}
          onChange={(axis, value) =>
            updateNode((current) => ({
              ...current,
              transform: { ...current.transform, rotation: { ...(current.transform?.rotation ?? { x: 0, y: 0, z: 0, w: 1 }), [axis]: value } },
            }))
          }
        />

        <VectorFields
          label="Scale"
          value={transform.scale ?? { x: 1, y: 1, z: 1 }}
          onChange={(axis, value) =>
            updateNode((current) => ({
              ...current,
              transform: { ...current.transform, scale: { ...(current.transform?.scale ?? { x: 1, y: 1, z: 1 }), [axis]: value } },
            }))
          }
        />

        <div className="field">
          <label className="field-label" htmlFor="node_tags">
            Tags (comma separated)
          </label>
          <input
            id="node_tags"
            type="text"
            value={(node.tags ?? []).join(', ')}
            onChange={(event) =>
              updateNode((current) => ({
                ...current,
                tags: event.target.value
                  .split(',')
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              }))
            }
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="node_components">
            Components (JSON)
          </label>
          <textarea
            id="node_components"
            value={JSON.stringify(node.components ?? [], null, 2)}
            onChange={(event) => {
              try {
                const parsed = JSON.parse(event.target.value || '[]');
                updateNode((current) => ({ ...current, components: parsed }));
              } catch {
                /* ignore parse errors while typing */
              }
            }}
          />
          <div className="field-warning">Editing JSON updates live; invalid JSON is ignored.</div>
        </div>

        <div className="metadata">
          <div className="metadata-row">
            <span>ID</span>
            <code>{node.id}</code>
          </div>
          {node.asset && (
            <div className="metadata-row">
              <span>Asset</span>
              <code>{node.asset.assetId}</code>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

const AssetPanel = ({ assets = [] }) => (
  <section className="editor-panel asset-panel">
    <header className="panel-header">
      <div>
        <div className="panel-title">Assets</div>
        <div className="panel-subtitle">Library referenced by nodes</div>
      </div>
      <div className="inline-pill">{assets.length} items</div>
    </header>
    <div className="panel-body">
      {assets.length === 0 && <div className="asset-empty">No assets defined in this world.</div>}
      <div className="asset-grid">
        {assets.map((asset) => (
          <div key={asset.id} className="asset-tile" role="listitem">
            <div className="asset-label">{asset.id}</div>
            <div className="asset-meta">{asset.type ?? 'unknown'} asset</div>
            <div className="asset-uri">{asset.uri}</div>
          </div>
        ))}
      </div>
      <p className="asset-meta-note">Assets are stored once and referenced by ID in scene nodes.</p>
    </div>
  </section>
);

const hashString = (input) => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
};

const EditorApp = () => {
  const [world, setWorld] = useState(DEFAULT_WORLD);
  const [selection] = useState(() => new SelectionManager());
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [dirty, setDirty] = useState(false);

  const [modeManager] = useState(
    () =>
      new ModeManager(
        {
          createContext: (mode) => ({
            mode,
            activate: () => console.log(`[World Editor] entering ${mode} mode`),
            deactivate: () => console.log(`[World Editor] leaving ${mode} mode`),
          }),
          autoSave: () => console.info('[World Editor] Auto-saving before switching modes'),
          hasUnsavedChanges: () => dirty,
        },
        'edit'
      )
  );

  const selectedId = selection.getFocused();
  const selectedNode = selectedId ? findNodeById(world.nodes, selectedId) : undefined;

  useEffect(() => {
    if (!selection.getFocused() && world.nodes.length > 0) {
      selection.setSelection([world.nodes[0].id]);
      setSelectionRevision((value) => value + 1);
    }
  }, [selection, world.nodes]);

  const updateNode = (id, updater) => {
    setWorld((current) => {
      const { nodes, changed } = updateNodeById(current.nodes, id, updater);
      if (!changed) return current;
      const updated = { ...current, nodes };
      setDirty(true);
      modeManager.markDirty();
      return updated;
    });
  };

  const handleSelectionChange = () => setSelectionRevision((value) => value + 1);

  const handleFocusRequest = (id) => {
    selection.focus(id);
    setSelectionRevision((value) => value + 1);
  };

  const handleImport = async (payload) => {
    const nextWorld = deserializeWorld(payload);
    setWorld(nextWorld);
    const first = nextWorld.nodes[0]?.id;
    selection.setSelection(first ? [first] : []);
    setSelectionRevision((value) => value + 1);
    setDirty(false);
    modeManager.clearDirty();
  };

  const handleExport = () => {
    const serialized = serializeWorld(world);
    return { hash: hashString(serialized), world, exportedAt: new Date().toISOString() };
  };

  const hierarchySummary = `${world.nodes.length} root node${world.nodes.length === 1 ? '' : 's'}`;
  const selectionSummary = selectedNode ? `${selectedNode.name ?? selectedNode.id}` : 'No selection';

  return (
    <div className="editor-layout" role="application" aria-label="World Engine editor">
      <div>
        <header className="hero-header">
          <div className="hero-titles">
            <h1>World Engine scene editor</h1>
            <p>Edit, inspect, and export world documents directly in the browser.</p>
          </div>
          <ModeToggle manager={modeManager} onCancel={() => console.warn('Mode switch canceled')} />
        </header>
        <div className="mode-banner">
          <div className="summary-chip">{hierarchySummary}</div>
          <div className="summary-chip">Selection: {selectionSummary}</div>
          <div className="summary-chip">{dirty ? 'Unsaved changes' : 'All changes saved'}</div>
        </div>
        <HierarchyPanel
          key={selectionRevision}
          nodes={world.nodes}
          selection={selection}
          onSelectionChange={handleSelectionChange}
          onFocusRequest={handleFocusRequest}
        />
      </div>
      <InspectorPanel world={world} selection={selection} onUpdateNode={updateNode} />
      <div className="stack">
        <AssetPanel assets={world.assets} />
        <section className="editor-panel">
          <header className="panel-header">
            <div>
              <div className="panel-title">World I/O</div>
              <div className="panel-subtitle">Import and export schema v{CURRENT_WORLD_SCHEMA_VERSION}</div>
            </div>
          </header>
          <div className="panel-body">
            <WorldIoMenu onExport={handleExport} onImport={handleImport} />
          </div>
        </section>
      </div>
    </div>
  );
};

const rootElement = document.getElementById('editor-root');
const root = createRoot(rootElement);
root.render(<EditorApp />);
