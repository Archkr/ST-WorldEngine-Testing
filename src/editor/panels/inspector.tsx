import React from 'react';
import { SceneNode, Transform } from '../../world/schema';

export type InspectorPanelProps = {
  node?: SceneNode;
  onRename?: (id: string, name: string) => void;
  onTransformChange?: (transform: Transform) => void;
};

const formatVector = (value?: { x?: number; y?: number; z?: number }) =>
  `${value?.x ?? 0}, ${value?.y ?? 0}, ${value?.z ?? 0}`;

export const InspectorPanel: React.FC<InspectorPanelProps> = ({ node, onRename, onTransformChange }) => {
  if (!node) {
    return (
      <section className="editor-panel inspector-panel empty">
        <header className="panel-header">
          <div className="panel-title">Inspector</div>
        </header>
        <div className="panel-body">Select a node to see its properties.</div>
      </section>
    );
  }

  const handleNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    onRename?.(node.id, event.target.value);
  };

  const handleTransformChange = (key: keyof Transform, axis: keyof Transform['position'], value: number) => {
    const transform: Transform = {
      position: { ...node.transform?.position, ...(key === 'position' ? { [axis]: value } : {}) },
      rotation: { ...node.transform?.rotation },
      scale: { ...node.transform?.scale },
    };
    onTransformChange?.(transform);
  };

  return (
    <section className="editor-panel inspector-panel">
      <header className="panel-header">
        <div className="panel-title">Inspector</div>
        <div className="panel-subtitle">{node.name ?? node.id}</div>
      </header>
      <div className="panel-body inspector-fields">
        <label className="field">
          <span className="field-label">Name</span>
          <input type="text" defaultValue={node.name ?? ''} onChange={handleNameChange} />
        </label>
        <div className="field-group">
          <span className="field-label">Transform</span>
          <div className="field-grid">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <label className="field" key={axis}>
                <span className="field-label">{axis.toUpperCase()}</span>
                <input
                  type="number"
                  defaultValue={(node.transform?.position as Record<string, number> | undefined)?.[axis] ?? 0}
                  onChange={(event) => handleTransformChange('position', axis, Number(event.target.value))}
                />
              </label>
            ))}
          </div>
        </div>
        <div className="metadata">
          <div className="metadata-row">
            <span>ID</span>
            <code>{node.id}</code>
          </div>
          <div className="metadata-row">
            <span>Rotation</span>
            <code>{formatVector(node.transform?.rotation)}</code>
          </div>
          <div className="metadata-row">
            <span>Scale</span>
            <code>{formatVector(node.transform?.scale)}</code>
          </div>
          <div className="metadata-row">
            <span>Tags</span>
            <code>{node.tags?.join(', ') ?? '—'}</code>
          </div>
        </div>
      </div>
    </section>
  );
};

export default InspectorPanel;
