import React, { useState } from "react";
import { Meta, StoryFn } from "@storybook/react";
import { CodeEditorWithDiff, CodeEditorWithDiffProps, Cursor } from "./CodeEditorWithDiff";

export default {
    title: "Editors/CodeEditorWithDiff",
    component: CodeEditorWithDiff,
} as Meta<typeof CodeEditorWithDiff>;

const INITIAL_CODE = `function processData(items) {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    count += items[i].value;
  }
  return count;
}

const mockData = [{ value: 10 }, { value: 20 }];
console.log(processData(mockData));`;

const DIFF_CODE = `function processData(items) {
  // Converted to reduce for simplicity
  return items.reduce((sum, item) => sum + item.value, 0);
}

const mockData = [{ value: 10 }, { value: 20 }];
console.log(processData(mockData));
console.log('Script finished.');`;

const Template: StoryFn<CodeEditorWithDiffProps> = (args) => {
    const [code, setCode] = useState(args.code);

    // NOTE: This state is meant ONLY for remote cursors fetched from a server.
    // We do NOT add our own local cursor to this array.
    const [remoteCursors, setRemoteCursors] = useState<Cursor[]>(args.cursors || []);

    const handleCursorMove = (pos: number | null) => {
        // In a real app, you would broadcast pos via websockets here.
        // Example: socket.emit('cursorMove', pos);
    };

    const handleChange = (newCode: string, pos: number | null) => {
        setCode(newCode);
        // In a real app, you would broadcast the new code and pos here.
    };

    return (
        <div className="p-4 max-w-8xl mx-auto">
            <CodeEditorWithDiff
                {...args}
                code={code}
                cursors={remoteCursors}
                onChange={handleChange}
                onCursorMove={handleCursorMove}
            />
        </div>
    );
};

export const WithoutDiff = Template.bind({});
WithoutDiff.args = {
    code: INITIAL_CODE,
    // Simulating another user named EditorOne currently in the file
    cursors: [{ label: "EditorOne", pos: 15 }],
    diff: null,
};

export const WithDiff = Template.bind({});
WithDiff.args = {
    code: INITIAL_CODE,
    cursors: [{ label: "EditorOne", pos: 15 }],
    diff: {
        code: DIFF_CODE,
        cursors: [
            { label: "ReviewerA", pos: 45 },
            { label: "ReviewerB", pos: 80 },
        ],
    },
};
