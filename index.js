"use strict";

let promptView = null;

module.exports = {
	disposables: null,

	/**
	 * Activate package and handle event subscriptions.
	 * @api private
	 */
	activate(){
		this.disposables = new (require("atom").CompositeDisposable)(
			atom.commands.add("atom-text-editor:not([mini])", {
				"language-rfc:go-to-page": this.goToPage.bind(this),
				"language-rfc:next-page":  this.nextPage.bind(this),
				"language-rfc:prev-page":  this.prevPage.bind(this),
			}),
		);
		this.observeEditors(this.autoDetect.bind(this));
	},

	/**
	 * Deactivate package.
	 * @api private
	 */
	deactivate(){
		this.disposables?.dispose();
		this.disposables = null;
	},

	/**
	 * Auto-detect IETF RFC documents when opened.
	 * @param {TextEditor} editor
	 * @return {void}
	 * @api private
	 */
	autoDetect(editor){
		const name = editor.getFileName();
		if(!name || atom.textEditors.getGrammarOverride(editor)) return;
		switch(editor.getGrammar().scopeName){
			case "text.plain":
			case "text.plain.null-grammar":
				if(/^(?:rfc|bcp|fyi|ien|std)\d+\.txt$/.test(name))
					atom.textEditors.setGrammarOverride(editor, "text.rfc");
		}
	},

	/**
	 * Invoke a callback for every {@link TextEditor} open in the workspace.
	 * @param {Function} callback
	 * @return {void}
	 * @api private
	 */
	observeEditors(callback){
		this.disposables.add(atom.workspace.observeTextEditors(callback));
		if(!atom.packages.initialPackagesActivated){
			const disposable = atom.packages.onDidActivateInitialPackages(() => {
				disposable.dispose();
				this.disposables.delete(disposable);
				setTimeout(() => atom.textEditors.editors.forEach(callback), 100);
			});
			this.disposables.add(disposable);
		}
	},

	/**
	 * Prompt user for input.
	 *
	 * @param {String} message - Explanatory text displayed above input field
	 * @param {String} [footnote=""] - Additional text displayed below input field
	 * @param {String} [defaultValue=""] - Initial contents of input field
	 * @return {Promise} Resolves with user's response, or null if prompt was cancelled
	 * @api private
	 */
	async prompt(message, footnote = "", defaultValue = ""){
		promptView ||= new (require("prompt-view"))({headerTagName: "label"});
		return promptView.promptUser({
			headerText: message,
			footerText: footnote,
			input: defaultValue,
		});
	},

	/**
	 * Return the {@link TextEditor} associated with a command invocation.
	 *
	 * @param {Event|TextEditor} input
	 * @return {TextEditor}
	 * @private
	 */
	resolveEditorArgument(input){
		if(input instanceof Event){
			let editor = input.currentTarget;
			if(atom.workspace.isTextEditor(editor))
				return editor;
			if(editor instanceof HTMLElement){
				if(editor.tagName !== "ATOM-TEXT-EDITOR")
					editor = editor.closest("atom-text-editor");
				if(atom.workspace.isTextEditor(editor = editor?.getModel()))
					return editor;
			}
		}
		return atom.workspace.getActiveTextEditor();
	},

	/**
	 * Scroll to the designated line number.
	 *
	 * @param {Number} number - Line number, indexed from zero
	 * @param {Number} [offset=0] - Additional lines to scroll
	 * @param {TextEditor} [editor]
	 * @return {void}
	 * @private
	 */
	goToLine(number, offset = 0, editor = atom.workspace.getActiveTextEditor()){
		if("object" === typeof offset)
			[editor, offset] = [offset, 0];
		const pos = {row: number, column: 0};
		editor.setSelectedBufferRange([pos, pos]);
		pos.row += offset;
		editor.scrollToBufferPosition(pos);
	},

	/**
	 * Jump to the designated page number.
	 *
	 * @param {Number} number
	 * @param {TextEditor} [editor]
	 * @return {Promise<String>|undefined}
	 * @private
	 */
	goToPage(number = null, editor = null){
		if(number instanceof Event || isNaN(number))
			return this.prompt("Enter a page number").then(value => {
				if(isFinite(value = parseInt(value, 10)))
					this.goToPage(value);
			});
		console.log(`Jumping to page: ${number}`);
		editor ||= atom.workspace.getActiveTextEditor();
		const breaks = editor.buffer.findAllSync(/^\f$/m);
		number = Math.max(1, Math.round(+number));
		number = Math.min(number, breaks.length);
		if(number > 1){
			const linePos = breaks[number - 2].start;
			linePos.row += editor.rowsPerPage - 2;
			editor.setSelectedBufferRange(linePos);
			editor.scrollToBufferPosition(linePos);
		}
		else{
			const zero = {row: 0, column: 0};
			editor.setSelectedBufferRange([zero, zero]);
			editor.scrollToBufferPosition(zero);
		}
	},

	/**
	 * Scroll upwards to the previous page.
	 *
	 * @param {Event} [event=null]
	 * @return {void}
	 * @private
	 */
	prevPage(event = null){
		const editor = this.resolveEditorArgument(event);
		const [selection] = editor.getSelectionsOrderedByBufferPosition();
		let start = Math.min(...selection.getBufferRowRange());
		"\f" === editor.lineTextForBufferRow(start) && --start;
		for(let i = start; i >= 0; --i)
			if(!i || "\f" === editor.lineTextForBufferRow(i))
				return this.goToLine(i, editor);
	},

	/**
	 * Scroll downwards to the next page.
	 *
	 * @param {Event} [event=null]
	 * @return {void}
	 * @private
	 */
	nextPage(event = null){
		const editor = this.resolveEditorArgument(event);
		const numRows = editor.getLastBufferRow();
		const [selection] = editor.getSelectionsOrderedByBufferPosition();
		let start = Math.max(...selection.getBufferRowRange());
		"\f" === editor.lineTextForBufferRow(start) && ++start;
		for(let i = start; i < numRows; ++i)
			if(i >= numRows - 1 || "\f" === editor.lineTextForBufferRow(i))
				return this.goToLine(i, editor.rowsPerPage - 5, editor);
	},
};
