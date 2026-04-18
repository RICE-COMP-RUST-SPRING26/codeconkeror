import React, { useEffect, useRef, useMemo } from "react";
import { basicSetup } from "codemirror";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { diffLines } from "diff";

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

type LineDecoration = { lineIndex: number; className: string };
type BlockSpacer = { lineNum: number; height: number; text?: string; className?: string };

const DIFF_LINE_HEIGHT = 24;

function clientColor(clientId: string): string {
    let hash = 0;
    for (let i = 0; i < clientId.length; i++) {
        hash = (hash * 31 + clientId.charCodeAt(i)) & 0x7fffffff;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 50%)`;
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
        // z-index added to ensure it overlays the CodeMirror line stacking context
        wrapper.style.cssText =
            "position: relative; display: inline-block; width: 0; height: 0; vertical-align: top; overflow: visible; pointer-events: none; z-index: 100;";

        const bar = document.createElement("span");
        // FIX: Gave the bar an explicit height to match the line, rather than relying on top/bottom
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
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const el = document.createElement("div");
        el.style.height = `${this.height}px`;
        el.style.lineHeight = `${DIFF_LINE_HEIGHT}px`;
        el.className = this.className || "";
        el.style.boxSizing = "border-box";
        el.style.overflow = "hidden";
        el.style.whiteSpace = "pre";

        if (this.text) {
            el.textContent = this.text.endsWith("\n") ? this.text.slice(0, -1) : this.text;
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
            other.className === this.className
        );
    }
    ignoreEvent() {
        return true;
    }
}

const setCursorsEffect = StateEffect.define<Cursor[]>();
const setLineDecosEffect = StateEffect.define<LineDecoration[]>();
const setBlockSpacersEffect = StateEffect.define<BlockSpacer[]>();

const externalCursorsField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decos, tr) {
        decos = decos.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setCursorsEffect)) {
                const sorted = [...effect.value].sort((a, b) => a.pos - b.pos);
                const builder = new RangeSetBuilder<Decoration>();
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

                for (const { lineNum, height, text, className } of sorted) {
                    let pos: number;
                    let side: number;

                    if (lineNum <= 1) {
                        pos = 0;
                        side = -1;
                    } else if (lineNum > tr.newDoc.lines) {
                        pos = tr.newDoc.length;
                        side = 1;
                    } else {
                        pos = tr.newDoc.line(lineNum).from;
                        side = -1;
                    }

                    builder.add(
                        pos,
                        pos,
                        Decoration.widget({
                            widget: new BlockSpacerWidget(height, text, className),
                            block: true,
                            side: side,
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
    onChange?: (code: string, pos: number) => void;
    onCursorMove?: (pos: number) => void;
}

function BaseEditor({
    code,
    readOnly,
    cursors,
    lineDecorations,
    blockSpacers,
    onChange,
    onCursorMove,
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
            EditorView.updateListener.of((update) => {
                if (isExternalChange.current) return;
                if (update.docChanged) {
                    cbRef.current.onChange?.(
                        update.state.doc.toString(),
                        update.state.selection.main.head,
                    );
                } else if (update.selectionSet) {
                    cbRef.current.onCursorMove?.(update.state.selection.main.head);
                }
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
            if (view.state.doc.toString() !== code) {
                view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: code },
                });
            }
            view.dispatch({
                effects: [
                    setCursorsEffect.of(cursors ?? []),
                    setLineDecosEffect.of(lineDecorations ?? []),
                    setBlockSpacersEffect.of(blockSpacers ?? []),
                ],
            });
        } finally {
            isExternalChange.current = false;
        }
    }, [code, cursors, lineDecorations, blockSpacers]);

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
    const diffData = useMemo(() => {
        if (!diff) return null;

        const leftSpacers: BlockSpacer[] = [];
        const rightSpacers: BlockSpacer[] = [];
        const rightLineDecos: LineDecoration[] = [];

        const changes = diffLines(code, diff.code);
        let leftLine = 1;
        let rightLine = 1;

        for (const part of changes) {
            const lineCount = part.count || 0;

            if (part.removed) {
                rightSpacers.push({
                    lineNum: rightLine,
                    height: lineCount * DIFF_LINE_HEIGHT,
                    text: part.value,
                    className: "diff-spacer-red",
                });
                leftLine += lineCount;
            } else if (part.added) {
                for (let i = 0; i < lineCount; i++) {
                    rightLineDecos.push({
                        lineIndex: rightLine - 1 + i,
                        className: "diff-line-green",
                    });
                }
                leftSpacers.push({
                    lineNum: leftLine,
                    height: lineCount * DIFF_LINE_HEIGHT,
                    className: "",
                });
                rightLine += lineCount;
            } else {
                leftLine += lineCount;
                rightLine += lineCount;
            }
        }

        return { leftSpacers, rightSpacers, rightLineDecos };
    }, [code, diff]);

    return (
        <>
            <style>{`
        .diff-spacer-red {
          background-color: rgba(254, 226, 226, 0.6); 
          color: #7f1d1d; 
        }
        .diff-line-green {
          background-color: rgba(220, 252, 231, 0.6) !important; 
        }
      `}</style>

            <div className="relative w-full h-[600px] overflow-auto border border-gray-300 rounded shadow-sm bg-white text-sm">
                {/*
          min-w-full and w-max allow the container to hug the largest content, 
          while flex-1 and min-w-[50%] ensure both columns are exactly identical in width.
        */}
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
                            className="flex-1 bg-gray-50 border-l border-gray-200 -ml-[1px]"
                            style={{ minWidth: "50%" }}
                        >
                            <BaseEditor
                                code={diff.code}
                                readOnly={true}
                                cursors={diff.cursors}
                                lineDecorations={diffData?.rightLineDecos}
                                blockSpacers={diffData?.rightSpacers}
                            />
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
