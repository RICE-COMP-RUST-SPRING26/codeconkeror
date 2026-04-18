import React, { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { basicSetup } from "codemirror";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { diffLines, isEndOfFile } from "./diff";

export type Cursor = {
    label: string;
    pos: number;
};

export type CodeEditorWithDiffProps = {
    code: string;
    cursors: Cursor[];
    onChange: (s: string, newCursorPos: number | null) => void;
    onCursorMove: (newCursorPos: number | null) => void;
    diff: { code: string; cursors: Cursor[] } | null;
};

type DiffChunk = {
    id: string;
    virtualStartLine: number;
    virtualLineCount: number;
    leftCharStart: number;
    leftCharEnd: number;
    replacementText: string;
};

type LineDecoration = { lineIndex: number; className: string };

type BlockSpacer = {
    lineNum: number;
    height: number;
    text?: string;
    className?: string;
    endOfFile?: boolean;
    conquerChunk?: DiffChunk;
    onConquer?: (chunk: DiffChunk) => void;
};

type InlineButton = {
    pos: number;
    chunk: DiffChunk;
    onConquer?: (chunk: DiffChunk) => void;
};

const DIFF_LINE_HEIGHT = 24;

function clientColor(clientId: string): string {
    let hash = 0;
    for (let i = 0; i < clientId.length; i++) {
        hash = (hash * 31 + clientId.charCodeAt(i)) & 0x7fffffff;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 50%)`;
}

// --- SHARED BUTTON GENERATOR ---
function createConquerDOMButton(
    chunk: DiffChunk,
    onConquer: (c: DiffChunk) => void,
): HTMLButtonElement {
    const btn = document.createElement("button");
    // Only basic identifier classes remain. Styling is handled in the <style> block.
    btn.className = `conquer-btn chunk-btn-${chunk.id}`;
    btn.style.top = "2px";
    btn.style.left = "2px";
    btn.title = "Conker Changes";
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/></svg>`;

    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onConquer(chunk);
    };
    return btn;
}

// --- CODEMIRROR WIDGETS ---
class ExternalCursorWidget extends WidgetType {
    constructor(
        readonly name: string,
        readonly color: string,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("span");
        wrapper.style.cssText =
            "position: relative; display: inline-block; width: 0; height: 0; vertical-align: top; overflow: visible; pointer-events: none; z-index: 100;";

        const bar = document.createElement("span");
        bar.style.cssText = `position: absolute; top: 0; left: -1px; width: 2px; height: ${DIFF_LINE_HEIGHT}px; background: ${this.color}; z-index: 100;`;

        const label = document.createElement("span");
        label.textContent = this.name || "?";
        label.style.cssText = [
            "position: absolute",
            "bottom: 100%",
            "left: -1px",
            `background: ${this.color}`,
            "color: white",
            "font-size: 10px",
            "line-height: 1.4",
            "padding: 1px 4px",
            "border-radius: 3px 3px 3px 0",
            "white-space: nowrap",
            "font-family: sans-serif",
            "margin-bottom: 1px",
            "z-index: 101",
        ].join("; ");

        wrapper.appendChild(label);
        wrapper.appendChild(bar);
        return wrapper;
    }
    eq(other: ExternalCursorWidget) {
        return other.name === this.name && other.color === this.color;
    }
}

class BlockSpacerWidget extends WidgetType {
    constructor(
        readonly height: number,
        readonly text?: string,
        readonly className?: string,
        readonly conquerChunk?: DiffChunk,
        readonly onConquer?: (c: DiffChunk) => void,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const el = document.createElement("div");
        el.style.position = "relative";
        el.style.height = `${this.height}px`;
        el.style.lineHeight = `${DIFF_LINE_HEIGHT}px`;
        el.className = this.className || "";
        el.style.boxSizing = "border-box";
        //el.style.overflow = "hidden";
        el.style.whiteSpace = "pre";

        if (this.conquerChunk && this.onConquer) {
            const btn = createConquerDOMButton(this.conquerChunk, this.onConquer);
            el.appendChild(btn);
        }

        if (this.text) {
            const textSpan = document.createElement("span");
            textSpan.textContent = this.text.endsWith("\n") ? this.text.slice(0, -1) : this.text;
            el.appendChild(textSpan);
        }
        return el;
    }

    get estimatedHeight() {
        return this.height;
    }
    eq(other: BlockSpacerWidget) {
        return (
            other.height === this.height &&
            other.text === this.text &&
            other.className === this.className &&
            other.conquerChunk?.id === this.conquerChunk?.id
        );
    }
    ignoreEvent() {
        return true;
    }
}

class ConquerInlineWidget extends WidgetType {
    constructor(
        readonly chunk: DiffChunk,
        readonly onConquer: (c: DiffChunk) => void,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("span");
        wrapper.style.cssText =
            "position: relative; display: inline-block; width: 0; height: 0; vertical-align: top;";

        const btn = createConquerDOMButton(this.chunk, this.onConquer);
        wrapper.appendChild(btn);

        return wrapper;
    }

    eq(other: ConquerInlineWidget) {
        return other.chunk.id === this.chunk.id;
    }
    ignoreEvent() {
        return true;
    }
}

// --- STATE EFFECTS & FIELDS ---
const setCursorsEffect = StateEffect.define<Cursor[]>();
const setLineDecosEffect = StateEffect.define<LineDecoration[]>();
const setBlockSpacersEffect = StateEffect.define<BlockSpacer[]>();
const setInlineButtonsEffect = StateEffect.define<InlineButton[]>();

const externalCursorsField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        decos = decos.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setCursorsEffect)) {
                const builder = new RangeSetBuilder<Decoration>();
                const sorted = [...effect.value].sort((a, b) => a.pos - b.pos);
                for (const c of sorted) {
                    const pos = Math.max(0, Math.min(c.pos, tr.newDoc.length));
                    builder.add(
                        pos,
                        pos,
                        Decoration.widget({
                            widget: new ExternalCursorWidget(c.label, clientColor(c.label)),
                            side: 1,
                        }),
                    );
                }
                decos = builder.finish();
            }
        }
        return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
});

const lineDecorationsField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        decos = decos.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setLineDecosEffect)) {
                const builder = new RangeSetBuilder<Decoration>();
                if (effect.value.length === 0) return builder.finish();
                const sorted = [...effect.value].sort((a, b) => a.lineIndex - b.lineIndex);
                for (const { lineIndex, className } of sorted) {
                    const lineNum = lineIndex + 1;
                    if (lineNum < 1 || lineNum > tr.newDoc.lines) continue;
                    const line = tr.newDoc.line(lineNum);
                    builder.add(
                        line.from,
                        line.from,
                        Decoration.line({ attributes: { class: className } }),
                    );
                }
                decos = builder.finish();
            }
        }
        return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
});

const blockSpacersField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        decos = decos.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setBlockSpacersEffect)) {
                const builder = new RangeSetBuilder<Decoration>();
                if (effect.value.length === 0) return builder.finish();
                const sorted = [...effect.value].sort((a, b) => a.lineNum - b.lineNum);
                for (const {
                    lineNum,
                    height,
                    text,
                    className,
                    endOfFile,
                    conquerChunk,
                    onConquer,
                } of sorted) {
                    let pos: number;
                    let side: number;
                    if (endOfFile || lineNum > tr.newDoc.lines) {
                        // Anchor after the last character so the user's cursor
                        // stays above this spacer while they type at the end.
                        pos = tr.newDoc.length;
                        side = 1;
                    } else if (lineNum <= 1) {
                        pos = 0;
                        side = -1;
                    } else {
                        pos = tr.newDoc.line(lineNum).from;
                        side = -1;
                    }

                    builder.add(
                        pos,
                        pos,
                        Decoration.widget({
                            widget: new BlockSpacerWidget(
                                height,
                                text,
                                className,
                                conquerChunk,
                                onConquer,
                            ),
                            block: true,
                            side,
                        }),
                    );
                }
                decos = builder.finish();
            }
        }
        return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
});

const inlineButtonsField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        decos = decos.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setInlineButtonsEffect)) {
                const builder = new RangeSetBuilder<Decoration>();
                const sorted = [...effect.value].sort((a, b) => a.pos - b.pos);
                for (const { pos, chunk, onConquer } of sorted) {
                    if (!onConquer) continue;
                    builder.add(
                        pos,
                        pos,
                        Decoration.widget({
                            widget: new ConquerInlineWidget(chunk, onConquer),
                            side: -1,
                        }),
                    );
                }
                decos = builder.finish();
            }
        }
        return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
});

// --- BASE EDITOR ---
interface BaseEditorProps {
    code: string;
    readOnly?: boolean;
    cursors?: Cursor[];
    lineDecorations?: LineDecoration[];
    blockSpacers?: BlockSpacer[];
    inlineButtons?: InlineButton[];
    onChange?: (code: string, pos: number) => void;
    onCursorMove?: (pos: number) => void;
    onConquer?: (chunk: DiffChunk) => void;
}

function BaseEditor({
    code,
    readOnly,
    cursors,
    lineDecorations,
    blockSpacers,
    inlineButtons,
    onChange,
    onCursorMove,
    onConquer,
}: BaseEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const isExternalChange = useRef(false);

    const cbRef = useRef({ onChange, onCursorMove });
    useEffect(() => {
        cbRef.current = { onChange, onCursorMove };
    }, [onChange, onCursorMove]);

    useEffect(() => {
        if (!containerRef.current) return;
        const extensions = [
            basicSetup,
            externalCursorsField,
            lineDecorationsField,
            blockSpacersField,
            inlineButtonsField,
            EditorView.updateListener.of((update) => {
                if (isExternalChange.current) return;
                if (update.docChanged)
                    cbRef.current.onChange?.(
                        update.state.doc.toString(),
                        update.state.selection.main.head,
                    );
                else if (update.selectionSet)
                    cbRef.current.onCursorMove?.(update.state.selection.main.head);
            }),
            EditorView.theme({
                "&": { height: "auto", minHeight: "100%", width: "100%" },
                ".cm-scroller": { overflow: "visible !important", fontFamily: "monospace" },
                ".cm-line": { lineHeight: `${DIFF_LINE_HEIGHT}px` },
                ".cm-content": { padding: 0 },
            }),
        ];
        if (readOnly) extensions.push(EditorState.readOnly.of(true));

        const view = new EditorView({
            state: EditorState.create({ doc: code, extensions }),
            parent: containerRef.current,
        });
        viewRef.current = view;
        return () => view.destroy();
    }, [readOnly]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        isExternalChange.current = true;
        try {
            if (view.state.doc.toString() !== code)
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
            view.dispatch({
                effects: [
                    setCursorsEffect.of(cursors ?? []),
                    setLineDecosEffect.of(lineDecorations ?? []),
                    setBlockSpacersEffect.of(
                        (blockSpacers ?? []).map((bs) => ({ ...bs, onConquer })),
                    ),
                    setInlineButtonsEffect.of(
                        (inlineButtons ?? []).map((ib) => ({ ...ib, onConquer })),
                    ),
                ],
            });
        } finally {
            isExternalChange.current = false;
        }
    }, [code, cursors, lineDecorations, blockSpacers, inlineButtons, onConquer]);

    return <div ref={containerRef} className="h-full" />;
}

// --- MAIN COMPONENT ---
export function CodeEditorWithDiff({
    code,
    cursors,
    onChange,
    onCursorMove,
    diff,
}: CodeEditorWithDiffProps) {
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const [hoveredChunkId, setHoveredChunkId] = useState<string | null>(null);

    const handleConquer = useCallback(
        (chunk: DiffChunk) => {
            const newCode =
                code.slice(0, chunk.leftCharStart) +
                chunk.replacementText +
                code.slice(chunk.leftCharEnd);
            const newCursorPos = chunk.leftCharStart + chunk.replacementText.length;
            onChange(newCode, newCursorPos);
            setHoveredChunkId(null);
        },
        [code, onChange],
    );

    const diffData = useMemo(() => {
        if (!diff) return null;

        const leftSpacers: BlockSpacer[] = [];
        const rightSpacers: BlockSpacer[] = [];
        const rightLineDecos: LineDecoration[] = [];
        const inlineButtons: InlineButton[] = [];
        const chunks: DiffChunk[] = [];

        const changes = diffLines(code, diff.code);

        let leftLine = 1,
            rightLine = 1;
        let leftCharIdx = 0,
            rightCharIdx = 0;
        let virtualLine = 0;
        let currentChunk: DiffChunk | null = null;

        const finishChunk = () => {
            if (currentChunk) {
                chunks.push(currentChunk);
                currentChunk = null;
            }
        };

        for (const part of changes) {
            const lineCount = part.count || 0;

            if (part.removed || part.added) {
                const isNewChunk = !currentChunk;
                if (isNewChunk) {
                    currentChunk = {
                        id: `chunk-${leftLine}-${rightLine}`,
                        virtualStartLine: virtualLine,
                        virtualLineCount: 0,
                        leftCharStart: leftCharIdx,
                        leftCharEnd: leftCharIdx,
                        replacementText: "",
                    };
                }

                const chunkClass = `chunk-${currentChunk!.id}`;

                if (part.removed) {
                    rightSpacers.push({
                        lineNum: rightLine,
                        height: lineCount * DIFF_LINE_HEIGHT,
                        text: part.value,
                        className: `diff-spacer-red ${chunkClass}`,
                        conquerChunk: isNewChunk ? currentChunk! : undefined,
                    });

                    currentChunk!.leftCharEnd += part.value.length;
                    leftLine += lineCount;
                    leftCharIdx += part.value.length;
                    currentChunk!.virtualLineCount += lineCount;
                    virtualLine += lineCount;
                } else if (part.added) {
                    if (isNewChunk) {
                        inlineButtons.push({ pos: rightCharIdx, chunk: currentChunk! });
                    }
                    for (let i = 0; i < lineCount; i++) {
                        rightLineDecos.push({
                            lineIndex: rightLine - 1 + i,
                            className: `diff-line-green ${chunkClass}`,
                        });
                    }
                    leftSpacers.push({
                        lineNum: leftLine,
                        height: lineCount * DIFF_LINE_HEIGHT,
                        className: chunkClass,
                        endOfFile: isEndOfFile(code, leftLine),
                    });

                    currentChunk!.replacementText += part.value;
                    rightLine += lineCount;
                    rightCharIdx += part.value.length;
                    currentChunk!.virtualLineCount += lineCount;
                    virtualLine += lineCount;
                }
            } else {
                finishChunk();
                leftLine += lineCount;
                rightLine += lineCount;
                leftCharIdx += part.value.length;
                rightCharIdx += part.value.length;
                virtualLine += lineCount;
            }
        }
        finishChunk();

        return { leftSpacers, rightSpacers, rightLineDecos, inlineButtons, chunks };
    }, [code, diff]);

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!diffData || !scrollContainerRef.current) return;
        const rect = scrollContainerRef.current.getBoundingClientRect();
        const scrollTop = scrollContainerRef.current.scrollTop;
        const vLine = Math.floor((e.clientY - rect.top + scrollTop) / DIFF_LINE_HEIGHT);
        const hovered = diffData.chunks.find(
            (c) => vLine >= c.virtualStartLine && vLine < c.virtualStartLine + c.virtualLineCount,
        );
        setHoveredChunkId(hovered ? hovered.id : null);
    };

    return (
        <>
            <style>{`
                .diff-spacer-red { background-color: rgba(254, 226, 226, 0.5) !important; color: #7f1d1d; }
                .diff-line-green { background-color: rgba(220, 252, 231, 0.5) !important; }
                
                /* Pure CSS replacement for the Tailwind button classes */
                .conquer-btn {
                    position: absolute;
                    z-index: 200;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 28px;
                    height: 28px;
                    border-radius: 4px;
                    cursor: pointer;
                    transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
                    opacity: 0;
                    padding: 0;
                    pointer-events: none;
                    background-color: #eee;
                    border: 1px solid #888;
                    color: #222;
                }
                .conquer-btn:hover {
                    background-color: #ddd;
                }

                ${
                    hoveredChunkId
                        ? `
                .chunk-${hoveredChunkId}.diff-spacer-red { background-color: rgba(254, 226, 226, 0.95) !important; }
                            .chunk-${hoveredChunkId}.diff-line-green { background-color: rgba(187, 247, 208, 0.95) !important; }
                
                /* This toggles the button from hidden to fully interactive & visible */
                    .chunk-btn-${hoveredChunkId} {
                        opacity: 1 !important;
                        pointer-events: auto !important;
                        transform: scale(1.1);
                    }
                `
                        : ""
                }
                `}</style>

            <div
                ref={scrollContainerRef}
                className="w-full h-full overflow-auto border border-gray-300 rounded shadow-sm bg-white text-sm"
            >
                <div
                    className="min-h-full min-w-full w-max"
                    style={{ display: "flex", flexDirection: "row" }}
                >
                    <div
                        className={`flex-1 border-r border-gray-200 ${diff ? "" : "w-full"}`}
                        style={{ minWidth: diff ? "50%" : "100%" }}
                    >
                        <BaseEditor
                            code={code}
                            cursors={cursors}
                            onChange={onChange}
                            onCursorMove={onCursorMove}
                            blockSpacers={diffData?.leftSpacers}
                        />
                    </div>

                    {diff && (
                        <div
                            className="relative flex-1 bg-gray-50 border-l border-gray-200 -ml-[1px]"
                            style={{ minWidth: "50%" }}
                            onMouseMove={handleMouseMove}
                            onMouseLeave={() => setHoveredChunkId(null)}
                        >
                            <BaseEditor
                                code={diff.code}
                                readOnly={true}
                                cursors={diff.cursors}
                                lineDecorations={diffData?.rightLineDecos}
                                blockSpacers={diffData?.rightSpacers}
                                inlineButtons={diffData?.inlineButtons}
                                onConquer={handleConquer}
                            />
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
