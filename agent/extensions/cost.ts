/**
 * /cost command - shows the current model's pricing and session cost.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cost", {
		description: "Show current model pricing and session cost",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const lines: string[] = [];

			// Header
			lines.push(`Model:       ${model.provider}/${model.id}`);
			lines.push("");

			// Model pricing (per million tokens)
			const c = model.cost;
			lines.push("Pricing (per 1M tokens):");
			lines.push(`  Input:       $${c.input.toFixed(2)}`);
			lines.push(`  Output:      $${c.output.toFixed(2)}`);
			lines.push(`  Cache Read:  $${c.cacheRead.toFixed(2)}`);
			lines.push(`  Cache Write: $${c.cacheWrite.toFixed(2)}`);

			if (c.tiers && c.tiers.length > 0) {
				lines.push("");
				lines.push("Pricing Tiers:");
				for (const tier of c.tiers) {
					lines.push(`  > ${tier.inputTokensAbove.toLocaleString()} input tokens:`);
					lines.push(`    Input:       $${tier.input.toFixed(2)}`);
					lines.push(`    Output:      $${tier.output.toFixed(2)}`);
					lines.push(`    Cache Read:  $${tier.cacheRead.toFixed(2)}`);
					lines.push(`    Cache Write: $${tier.cacheWrite.toFixed(2)}`);
				}
			}

			// Context window
			lines.push("");
			lines.push(`Context Window: ${(model.contextWindow / 1000).toFixed(0)}K tokens`);
			lines.push(`Max Output:     ${(model.maxTokens / 1000).toFixed(0)}K tokens`);

			// Session cost
			lines.push("");
			lines.push("Session Usage:");
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;
			let msgCount = 0;

			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					const m = entry.message as AssistantMessage;
					if (m.usage) {
						totalInput += m.usage.input;
						totalOutput += m.usage.output;
						totalCacheRead += m.usage.cacheRead;
						totalCacheWrite += m.usage.cacheWrite;
						totalCost += m.usage.cost.total;
						msgCount++;
					}
				}
			}

			if (msgCount === 0) {
				lines.push("  No assistant responses yet.");
			} else {
				const fmt = (n: number) => {
					if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
					if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
					return `${n}`;
				};
				lines.push(`  Messages:       ${msgCount}`);
				lines.push(`  Input tokens:   ${fmt(totalInput)}`);
				lines.push(`  Output tokens:  ${fmt(totalOutput)}`);
				lines.push(`  Cache read:     ${fmt(totalCacheRead)}`);
				lines.push(`  Cache write:    ${fmt(totalCacheWrite)}`);
				lines.push(`  Total cost:     $${totalCost.toFixed(4)}`);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}