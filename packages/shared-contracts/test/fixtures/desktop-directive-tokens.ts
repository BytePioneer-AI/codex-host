/**
 * Token shapes recorded from the installed Codex Desktop's own Markdown
 * lexer (`XpUB.o`) for the annotation directive, reduced to node kinds and the
 * `index` attribute so the expectation states what the grammar recognizes
 * rather than restating our own parser. Desktop 26.1106.51428 / build 26605.
 * Line endings / break tokens project to LF text; non-string index attributes
 * project to an empty index because they cannot identify an annotation.
 */
export interface DirectiveTokens {
  readonly text: string;
  readonly nodes: readonly DirectiveNode[];
}

export interface DirectiveNode {
  readonly type: "text" | "inlineCode" | "code" | "link" | "directive";
  readonly value?: string;
  readonly index?: string;
  readonly children?: readonly DirectiveNode[];
}

export const DESKTOP_DIRECTIVE_TOKENS: readonly DirectiveTokens[] = [
  {
    text: 'A :codex-annotation{index="1"}, B :codex-annotation{index="2"}.',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: ", B " },
      { type: "directive", index: "2" },
      { type: "text", value: "." },
    ],
  },
  {
    text: 'A `:codex-annotation{index="1"}` B.',
    nodes: [
      { type: "text", value: "A " },
      { type: "inlineCode", value: ':codex-annotation{index="1"}' },
      { type: "text", value: " B." },
    ],
  },
  {
    text: '```text\n:codex-annotation{index="1"}\n```',
    nodes: [{ type: "code", value: ':codex-annotation{index="1"}' }],
  },
  {
    text: '[Keep :codex-annotation{index="1"} label](https://example.com)',
    nodes: [
      {
        type: "link",
        children: [
          { type: "text", value: "Keep " },
          { type: "directive", index: "1" },
          { type: "text", value: " label" },
        ],
      },
    ],
  },
  {
    text: 'Escaped \\:codex-annotation{index="1"}',
    nodes: [{ type: "text", value: 'Escaped :codex-annotation{index="1"}' }],
  },
  {
    text: 'A :codex-annotation{index="01"}, B :codex-annotation{index="0"}.',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "01" },
      { type: "text", value: ", B " },
      { type: "directive", index: "0" },
      { type: "text", value: "." },
    ],
  },
  {
    text: "A :codex-annotation{index='1'}, B :codex-annotation{index=1}.",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: ", B " },
      { type: "directive", index: "1" },
      { type: "text", value: "." },
    ],
  },
  {
    text: 'A :codex-annotation{index="1" extra="x"}.',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "." },
    ],
  },
  {
    text: 'A :codex-annotation{\tindex="1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{index="1\t"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1\t" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=\t1}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{\r\nindex="1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: '{\nindex="1"}B' },
    ],
  },
  {
    text: 'A :codex-annotation{index="1"\r\n}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: '{index="1"\n}B' },
    ],
  },
  {
    text: 'A :codex-annotation{index="1\r\n"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: '{index="1\n"}B' },
    ],
  },
  {
    text: 'A :codex-annotation{\nindex="1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: '{\nindex="1"}B' },
    ],
  },
  {
    text: 'A :codex-annotation{index="1"\n}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: '{index="1"\n}B' },
    ],
  },
  {
    text: 'A :codex-annotation{index="1\n"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: '{index="1\n"}B' },
    ],
  },
  {
    text: 'A :codex-annotation{\rindex="1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: '{\nindex="1"}B' },
    ],
  },
  {
    text: 'A :codex-annotation{index=1 extra="x"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=1 extra=x}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=1\textra=x}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=1 extra=2}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{index=" 1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: " 1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=' 1'}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: " 1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index='1\t'}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1\t" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index= 1}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index = 1}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{extra=x index="1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{extra index="1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=1extra=x}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{index="1\\"2"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: '1"2' },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index='1\\'2'}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1'2" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{extra="a\\"b" index="1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=01 extra=x}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=+1 extra=x}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "+1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=1.0 extra=x}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: "A :codex-annotation{index=1e0 extra=x}B",
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{index="&Tab;1"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "\t1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: 'A :codex-annotation{index="&#49;"}B',
    nodes: [
      { type: "text", value: "A " },
      { type: "directive", index: "1" },
      { type: "text", value: "B" },
    ],
  },
  {
    text: ":codex-annotation{:codex-annotation{:codex-annotation{",
    nodes: [
      { type: "directive", index: "" },
      { type: "text", value: "{" },
      { type: "directive", index: "" },
      { type: "text", value: "{" },
      { type: "directive", index: "" },
      { type: "text", value: "{" },
    ],
  },
  {
    text: ':codex-annotation[explanation]{index="1"} tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}{ index="2"} tail',
    nodes: [
      { type: "directive", index: "2" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}} tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}{extra=x} tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}[label] tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}{index="2"} tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation[explanation]{index="1"}{ index="2"} tail',
    nodes: [
      { type: "directive", index: "2" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation[first][second]{index="1"} tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}[label]{ index="2"} tail',
    nodes: [
      { type: "directive", index: "2" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ":codex-annotation[label] tail",
    nodes: [
      { type: "directive", index: "" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}{ index=" 2"} tail',
    nodes: [
      { type: "directive", index: " 2" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}{ index="2"}123 tail',
    nodes: [
      { type: "directive", index: "2" },
      { type: "text", value: "123 tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}}} tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}{ extra="x"} tail',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation{index="1"}{ index=\t2} tail',
    nodes: [
      { type: "directive", index: "" },
      { type: "text", value: " tail" },
    ],
  },
  {
    text: ':codex-annotation[label]\n{index="1"}',
    nodes: [
      { type: "directive", index: "" },
      { type: "text", value: '\n{index="1"}' },
    ],
  },
  {
    text: ':codex-annotation[label]{index="1"}B :codex-annotation{index="2"}C',
    nodes: [
      { type: "directive", index: "1" },
      { type: "text", value: "B " },
      { type: "directive", index: "2" },
      { type: "text", value: "C" },
    ],
  },
];
