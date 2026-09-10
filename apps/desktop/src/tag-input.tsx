import { useId, useState } from "react";

export function TagInput({
	tags,
	onChange,
	suggestions,
}: {
	tags: string[];
	onChange: (tags: string[]) => void;
	suggestions: string[];
}) {
	const id = useId();
	const [draft, setDraft] = useState("");
	function add() {
		const tag = draft.trim().toLowerCase();
		if (tag && !tags.includes(tag) && tags.length < 20)
			onChange([...tags, tag]);
		setDraft("");
	}
	return (
		<div className="tag-input">
			<label htmlFor={id}>Tags</label>
			<div className="input-row">
				<input
					id={id}
					list={`${id}-suggestions`}
					value={draft}
					maxLength={40}
					disabled={tags.length >= 20}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="Add a tag"
					aria-describedby={`${id}-hint`}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
				/>
				<button
					type="button"
					onClick={add}
					disabled={!draft.trim() || tags.length >= 20}
				>
					Add tag
				</button>
			</div>
			<datalist id={`${id}-suggestions`}>
				{suggestions
					.filter((tag) => !tags.includes(tag))
					.map((tag) => (
						<option key={tag} value={tag} />
					))}
			</datalist>
			<p className="hint" id={`${id}-hint`}>
				Press Enter or Add tag. Up to 20 tags.
			</p>
			{tags.length > 0 && (
				<ul className="tag-list">
					{tags.map((tag) => (
						<li key={tag}>
							<button
								type="button"
								className="tag"
								aria-label={`Remove tag ${tag}`}
								onClick={() => onChange(tags.filter((value) => value !== tag))}
							>
								{tag} <span aria-hidden="true">×</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
