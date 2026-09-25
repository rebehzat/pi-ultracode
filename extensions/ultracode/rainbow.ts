/**
 * Animated rainbow text, in the style of Claude Code's ultracode/ultrathink badge.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

// coral → yellow → green → teal → blue → purple → pink
const COLORS: [number, number, number][] = [
	[233, 137, 115],
	[228, 186, 103],
	[141, 192, 122],
	[102, 194, 179],
	[121, 157, 207],
	[157, 134, 195],
	[206, 130, 172],
];
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";

function mix(rgb: [number, number, number], shine: number): string {
	const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * shine));
	return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Color `text` with a rainbow that drifts along with `frame`, plus a bright
 * shine that sweeps across and then pauses.
 */
export function rainbow(text: string, frame: number, opts: { bold?: boolean } = {}): string {
	const chars = [...text];
	const sweep = chars.length + 8;
	const cycle = frame % (sweep * 2);
	const shinePos = cycle < sweep ? cycle - 4 : -99;
	const drift = Math.floor(frame / 3);
	const out = chars
		.map((c, i) => {
			const dist = Math.abs(i - shinePos);
			const shine = dist === 0 ? 0.75 : dist === 1 ? 0.4 : dist === 2 ? 0.15 : 0;
			return `${mix(COLORS[(i + drift) % COLORS.length]!, shine)}${c}`;
		})
		.join("");
	return `${opts.bold ? BOLD : ""}${out}${RESET}${opts.bold ? UNBOLD : ""}`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (frame: number) => SPINNER[frame % SPINNER.length]!;

export const KEYWORD_RE = /\bultracode\b/i;

/** Editor that paints the `ultracode` keyword in an animated rainbow while it is typed. */
export class UltracodeEditor extends CustomEditor {
	private timer?: ReturnType<typeof setInterval>;
	private frame = 0;
	dismissed = false;
	/** Whether the keyword was dismissed on the prompt that was just submitted. */
	submittedDismissed = false;
	/** Show the animated ⚡ultracode badge in the top border (ultracode mode on). */
	private badge = false;

	setBadge(on: boolean): void {
		this.badge = on;
		this.sync();
		this.tui.requestRender();
	}

	private hasKeyword(): boolean {
		return !this.dismissed && KEYWORD_RE.test(this.getText());
	}

	sync(): void {
		const active = this.badge || this.hasKeyword();
		if (active && !this.timer) {
			this.timer = setInterval(() => {
				this.frame++;
				this.tui.requestRender();
			}, 70);
		} else if (!active && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	handleInput(data: string): void {
		// Alt+W dismisses the keyword highlight for this prompt, like Claude Code.
		if (matchesKey(data, "alt+w") && KEYWORD_RE.test(this.getText())) {
			this.dismissed = !this.dismissed;
			this.sync();
			this.tui.requestRender();
			return;
		}
		const wasDismissed = this.dismissed;
		super.handleInput(data);
		if (!this.getText().trim()) {
			if (wasDismissed) this.submittedDismissed = true;
			this.dismissed = false;
		}
		this.sync();
	}

	render(width: number): string[] {
		let lines = super.render(width);
		if (!this.dismissed) {
			lines = lines.map((line) => line.replace(/\bultracode\b/gi, (m) => rainbow(m, this.frame, { bold: true })));
		}
		if (this.badge && lines.length) {
			// Overlay the badge on the trailing run of border characters, keeping the visible width.
			const label = "⚡ultracode";
			const top = lines[0]!;
			const borderColor = /^(?:\x1b\[[0-9;]*m)+/.exec(top)?.[0] ?? "";
			const run = `─{${visibleWidth(label) + 4}}`;
			lines[0] = top.replace(new RegExp(`${run}(?=[^─]*$)`), `─ ${rainbow(label, this.frame, { bold: true })}${borderColor} ─`);
		}
		return lines;
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
