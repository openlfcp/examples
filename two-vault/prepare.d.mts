// Types of prepare.mjs (plain JavaScript, run with node), for its test.
export declare const CANARIES: {
  readonly aBefore: string;
  readonly aAfter: string;
  readonly b: string;
  readonly legacy: string;
};
export declare const SECTION_TITLE: string;
export declare function launchPlan(): string;
export declare function legacyTasks(): string;
export declare function meetingNotes(): string;
export declare function settings(
  url: string,
  refPlacement: "child-line" | "inline",
): {
  refPlacement: "child-line" | "inline";
  defaultServer: string;
  sectionsPreview: true;
  settingsVersion: 2;
};
