interface DocControlsProps {
  docIdInput: string;
  name: string;
  onDocIdChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onOpen: () => void;
  onNew: () => void;
}

export default function DocControls({
  docIdInput,
  name,
  onDocIdChange,
  onNameChange,
  onOpen,
  onNew,
}: DocControlsProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={docIdInput}
          onChange={(e) => onDocIdChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onOpen()}
          placeholder="Doc id (32 hex chars)"
          className="flex-1 border border-gray-300 rounded px-2 py-1 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button
          onClick={onOpen}
          className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded text-sm"
        >
          Open
        </button>
        <button
          onClick={onNew}
          className="px-3 py-1 bg-green-500 hover:bg-green-600 text-white rounded text-sm"
        >
          New document
        </button>
      </div>
      <div className="flex gap-2 items-center">
        <label className="text-sm text-gray-600 flex-shrink-0">Your name:</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Anonymous"
          className="w-48 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
      </div>
    </div>
  );
}
