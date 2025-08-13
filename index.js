"use strict";

module.exports = {
	disposables: null,

	/**
	 * Activate package and handle event subscriptions.
	 * @api private
	 */
	activate(){
		this.disposables = new (require("atom").CompositeDisposable)();
		this.observeEditors(this.autoDetect.bind(this));
	},

	/**
	 * Deactivate package.
	 * @api private
	 */
	deactivate(){
		this.disposables && this.disposables.dispose();
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
};
