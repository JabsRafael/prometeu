/** Page content crosses an untrusted boundary; Rust validates this snapshot before returning it. */
export type BrowserRect = { x: number; y: number; width: number; height: number };
export type BrowserSelection = {
  url: string;
  selector: string;
  tag: string;
  text: string;
  html: string;
  styles: Record<string, string>;
  rect: BrowserRect;
  viewport: { width: number; height: number };
};
export type BrowserInspection = { active: boolean; selection: BrowserSelection | null };
