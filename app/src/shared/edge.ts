export type EdgeKind =
  | "import"
  | "dynamic_import"
  | "type_only"
  | "side_effect"
  | "calls"
  | "extends"
  | "implements";

export interface Edge {
  source: string;
  target: string;
  kind: EdgeKind;
  highlighted: boolean;
  weight?: number;
  label?: string;          // free-text relationship description rendered on the wire
}
