import React, { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { basicSetup } from "codemirror";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { diffLines, isEndOfFile } from "./diff";

// Import the CSS Module
import styles from "./styles.module.css";
import singleSwordSvg from "../../assets/sword.svg?raw";
import doubleSwordSvg from "../../assets/double-sword.svg?raw";

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
    onConquerBoth?: (chunk: DiffChunk) => void;
};

type InlineButton = {
    pos: number;
    chunk: DiffChunk;
    onConquer?: (chunk: DiffChunk) => void;
    onConquerBoth?: (chunk: DiffChunk) => void;
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
function createButtonControls(
    chunk: DiffChunk,
    onConquer: (c: DiffChunk) => void,
    onConquerBoth: (c: DiffChunk) => void,
): HTMLDivElement {
    const container = document.createElement("div");

    // Give the container the absolute positioning that the old single button had
    // so it anchors correctly to the top-left of the CodeMirror widget wrappers.
    container.style.position = "absolute";
    container.style.top = "2px";
    container.style.left = "2px";
    container.style.display = "flex";
    container.style.gap = "4px";
    container.style.zIndex = "200";

    const createBtn = (title: string, svg: string, onClick: (e: MouseEvent) => void) => {
        const btn = document.createElement("button");

        // Apply BOTH the CSS module class and the dynamic hover targeting class directly to the button
        btn.className = `${styles.conquerBtn} chunk-btn-${chunk.id}`;
        btn.title = title;
        btn.innerHTML = svg;

        // Override the "absolute" from .conquerBtn so they sit side-by-side in this flex container
        btn.style.position = "static";

        btn.onclick = onClick;
        return btn;
    };

    const singleSword = singleSwordSvg;
    const doubleSword = doubleSwordSvg;

    container.appendChild(
        createBtn("Conker Changes (Accept New)", singleSword, (e) => {
            e.preventDefault();
            e.stopPropagation();
            onConquer(chunk);
        }),
    );

    container.appendChild(
        createBtn("Conker Both (Keep Both)", doubleSword, (e) => {
            e.preventDefault();
            e.stopPropagation();
            onConquerBoth(chunk);
        }),
    );

    return container;
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
        wrapper.className = styles.externalCursorWrapper;

        const bar = document.createElement("span");
        bar.className = styles.externalCursorBar;
        bar.style.height = `${DIFF_LINE_HEIGHT}px`;
        bar.style.background = this.color;

        const label = document.createElement("span");
        label.className = styles.externalCursorLabel;
        label.textContent = this.name || "?";
        label.style.background = this.color;

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
        readonly onConquerBoth?: (c: DiffChunk) => void,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const el = document.createElement("div");
        el.className = `${styles.blockSpacer} ${this.className || ""}`;
        el.style.height = `${this.height}px`;
        el.style.lineHeight = `${DIFF_LINE_HEIGHT}px`;

        if (this.conquerChunk && this.onConquer && this.onConquerBoth) {
            const btnGroup = createButtonControls(
                this.conquerChunk,
                this.onConquer,
                this.onConquerBoth,
            );
            el.appendChild(btnGroup);
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
        readonly onConquerBoth: (c: DiffChunk) => void,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const wrapper = document.createElement("span");
        wrapper.className = styles.inlineWidgetWrapper;

        const btnGroup = createButtonControls(this.chunk, this.onConquer, this.onConquerBoth);
        wrapper.appendChild(btnGroup);

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
                    onConquerBoth,
                } of sorted) {
                    let pos: number;
                    let side: number;
                    if (endOfFile || lineNum > tr.newDoc.lines) {
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
                                onConquerBoth,
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
                for (const { pos, chunk, onConquer, onConquerBoth } of sorted) {
                    if (!onConquer || !onConquerBoth) continue;
                    builder.add(
                        pos,
                        pos,
                        Decoration.widget({
                            widget: new ConquerInlineWidget(chunk, onConquer, onConquerBoth),
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
    onConquerBoth?: (chunk: DiffChunk) => void;
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
    onConquerBoth,
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
                        (blockSpacers ?? []).map((bs) => ({ ...bs, onConquer, onConquerBoth })),
                    ),
                    setInlineButtonsEffect.of(
                        (inlineButtons ?? []).map((ib) => ({ ...ib, onConquer, onConquerBoth })),
                    ),
                ],
            });
        } finally {
            isExternalChange.current = false;
        }
    }, [code, cursors, lineDecorations, blockSpacers, inlineButtons, onConquer, onConquerBoth]);

    return <div ref={containerRef} className={styles.baseEditorContainer} />;
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

    const handleConquerBoth = useCallback(
        (chunk: DiffChunk) => {
            const originalText = code.slice(chunk.leftCharStart, chunk.leftCharEnd);
            const replacementText = chunk.replacementText;

            // Ensure formatting cleanly splits the lines regardless of how the chunk ended
            const fmtOrig = originalText.endsWith("\n")
                ? originalText
                : originalText
                  ? originalText + "\n"
                  : "";
            const fmtRepl = replacementText.endsWith("\n")
                ? replacementText
                : replacementText
                  ? replacementText + "\n"
                  : "";

            const mergeBlock = `<<<<<<< HEAD\n${fmtOrig}=======\n${fmtRepl}>>>>>>> NEW\n`;

            const newCode =
                code.slice(0, chunk.leftCharStart) + mergeBlock + code.slice(chunk.leftCharEnd);

            const newCursorPos = chunk.leftCharStart + mergeBlock.length;
            onChange(newCode, newCursorPos);
            setHoveredChunkId(null);
        },
        [code, onChange],
    );

    const diffData = useMemo(() => {
        if (!diff) return null;

        const leftSpacers: BlockSpacer[] = [];
        const rightSpacers: BlockSpacer[] = [];
        const leftLineDecos: LineDecoration[] = [];
        const rightLineDecos: LineDecoration[] = [];
        const inlineButtons: InlineButton[] = [];
        const chunks: DiffChunk[] = [];

        const changes = diffLines(code, diff.code);

        let leftLine = 1,
            rightLine = 1;
        let leftCharIdx = 0,
            rightCharIdx = 0;
        let virtualLine = 0;

        for (let i = 0; i < changes.length; i++) {
            const part = changes[i];

            if (part.removed || part.added) {
                // 1. Collect all contiguous changes
                const subChanges = [];
                let j = i;
                while (j < changes.length && (changes[j].removed || changes[j].added)) {
                    subChanges.push(changes[j]);
                    j++;
                }
                i = j - 1;

                const removedParts = subChanges.filter((p) => p.removed);
                const addedParts = subChanges.filter((p) => p.added);

                const removedLineCount = removedParts.reduce((sum, p) => sum + (p.count || 0), 0);
                const addedLineCount = addedParts.reduce((sum, p) => sum + (p.count || 0), 0);
                const maxLines = Math.max(removedLineCount, addedLineCount);

                const chunkId = `chunk-${leftLine}-${rightLine}`;
                const chunk: DiffChunk = {
                    id: chunkId,
                    virtualStartLine: virtualLine,
                    virtualLineCount: maxLines,
                    leftCharStart: leftCharIdx,
                    leftCharEnd:
                        leftCharIdx + removedParts.reduce((sum, p) => sum + p.value.length, 0),
                    replacementText: addedParts.reduce((sum, p) => sum + p.value, ""),
                };
                chunks.push(chunk);
                const chunkClass = `chunk-${chunkId}`;

                // 2. Highlight content as Green
                for (let k = 0; k < removedLineCount; k++) {
                    leftLineDecos.push({
                        lineIndex: leftLine - 1 + k,
                        className: `${styles.diffLineGreen} ${chunkClass}`,
                    });
                }
                for (let k = 0; k < addedLineCount; k++) {
                    rightLineDecos.push({
                        lineIndex: rightLine - 1 + k,
                        className: `${styles.diffLineGreen} ${chunkClass}`,
                    });
                }

                // 3. Apply Red Padding
                if (addedLineCount > removedLineCount) {
                    leftSpacers.push({
                        lineNum: leftLine + removedLineCount,
                        height: (addedLineCount - removedLineCount) * DIFF_LINE_HEIGHT,
                        className: `${styles.diffSpacerRed} ${chunkClass}`,
                        endOfFile: isEndOfFile(code, leftLine + removedLineCount),
                    });
                } else if (removedLineCount > addedLineCount) {
                    rightSpacers.push({
                        lineNum: rightLine + addedLineCount,
                        height: (removedLineCount - addedLineCount) * DIFF_LINE_HEIGHT,
                        className: `${styles.diffSpacerRed} ${chunkClass}`,
                        conquerChunk: addedLineCount === 0 ? chunk : undefined,
                    });
                }

                // 4. Position Buttons
                if (addedLineCount > 0) {
                    inlineButtons.push({ pos: rightCharIdx, chunk });
                }

                leftLine += removedLineCount;
                rightLine += addedLineCount;
                leftCharIdx += removedParts.reduce((sum, p) => sum + p.value.length, 0);
                rightCharIdx += addedParts.reduce((sum, p) => sum + p.value.length, 0);
                virtualLine += maxLines;
            } else {
                leftLine += part.count || 0;
                rightLine += part.count || 0;
                leftCharIdx += part.value.length;
                rightCharIdx += part.value.length;
                virtualLine += part.count || 0;
            }
        }

        return { leftSpacers, rightSpacers, leftLineDecos, rightLineDecos, inlineButtons, chunks };
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
            {hoveredChunkId && (
                <style>{`
                    .chunk-${hoveredChunkId}.${styles.diffSpacerRed} { background-color: rgba(254, 226, 226, 0.95) !important; }
                    .chunk-${hoveredChunkId}.${styles.diffLineGreen} { background-color: rgba(187, 247, 208, 0.95) !important; }
                    .chunk-btn-${hoveredChunkId} {
                        opacity: 1 !important;
                        pointer-events: auto !important;
                        transform: scale(1.1) !important; /* <-- Added !important here */
                    }
                    `}</style>
            )}

            <div ref={scrollContainerRef} className={styles.container}>
                <div className={styles.editorWrapper}>
                    <div
                        className={`${styles.leftPane} ${diff ? styles.halfWidth : styles.fullWidth}`}
                    >
                        <BaseEditor
                            code={code}
                            cursors={cursors}
                            onChange={onChange}
                            onCursorMove={onCursorMove}
                            lineDecorations={diffData?.leftLineDecos}
                            blockSpacers={diffData?.leftSpacers}
                        />
                    </div>

                    {diff && (
                        <div
                            className={styles.rightPane}
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
                                onConquerBoth={handleConquerBoth}
                            />
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
