import { EditorView } from "@codemirror/view";

export const CODE_EDITOR_DOM_ID = "code-editor-main";

const LOREM_IPSUM =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor " +
    "incididunt ut labore et dolore magna aliqua.\n" +
    "Ut enim ad minim veniam, quis nostrud " +
    "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n";

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let loremPos = 0;

function getEditorView(): EditorView | null {
    const container = document.getElementById(CODE_EDITOR_DOM_ID);
    if (!container) return null;
    const cmEl = container.querySelector(".cm-editor");
    if (!cmEl) return null;
    return EditorView.findFromDOM(cmEl as HTMLElement);
}

export function isAutoInserting(): boolean {
    return intervalHandle !== null;
}

export function startAutoInsert(onStop: () => void): void {
    if (intervalHandle !== null) return;
    loremPos = 0;

    const view = getEditorView();
    if (view && !view.hasFocus) {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length } });
    }

    intervalHandle = setInterval(() => {
        const v = getEditorView();
        if (!v) return;

        if (!v.hasFocus) {
            stopAutoInsert();
            onStop();
            return;
        }

        const char = LOREM_IPSUM[loremPos];
        loremPos = (loremPos + 1) % LOREM_IPSUM.length;

        const cursor = v.state.selection.main.head;
        v.dispatch(
            v.state.update({
                changes: { from: cursor, to: cursor, insert: char },
                selection: { anchor: cursor + char.length },
                userEvent: "input",
            }),
        );
    }, 80);
}

export function stopAutoInsert(): void {
    if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}
