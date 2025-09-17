"use strict";

const {CompositeDisposable, Disposable, Point, Range} = require("atom");
const {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} = require("fs");
const {basename, dirname, join, normalize, resolve} = require("path");
const {execSync, spawnSync} = require("child_process");
const {parse: parseURL} = require("url");
const {tmpdir} = require("os");

const isDir  = path => existsSync(path) && statSync(path).isDirectory();
const isFile = path => existsSync(path) && statSync(path).isFile();
let rfcDirectory = null;
let promptView = null;

module.exports = {
	disposables: null,
	config: {
		rfcDirectory: {
			type: "string",
			title: "RFCs directory",
			description: "Directory where RFC documents are downloaded and cached for future retrieval. **Hint:** Set this to a [local mirror](https://www.rfc-editor.org/retrieve/rsync/) of the RFCs registry.",
			default: join("win32" === process.platform ? tmpdir() : "/tmp", "RFCs"),
			order: 1,
		},
		downloadEnabled: {
			type: "boolean",
			title: "Download missing RFCs",
			description: "Download RFCs on-demand when a requested file isn't found in the RFCs directory.",
			default: true,
			order: 2,
		},
		downloadSource: {
			type: "string",
			title: "Download source",
			description: "URL of site to download RFCs from. “#” characters are substituted with the requested RFC number.",
			default: "https://www.rfc-editor.org/rfc/rfc#.txt",
			order: 3,
		},
	},
	
	/**
	 * Read-only access to the [tilde-expanded]{@link expandPath} RFC directory path.
	 * @property {String} rfcDirectory
	 * @readonly
	 */
	get rfcDirectory(){
		return rfcDirectory;
	},

	/**
	 * Activate package and handle event subscriptions.
	 * @api private
	 */
	activate(){
		this.disposables = new CompositeDisposable(
			atom.workspace.addOpener(this.handleURI.bind(this)),
			atom.config.observe("language-rfc.rfcDirectory", value =>
				rfcDirectory = this.expandPath(value)),
			atom.commands.add("atom-text-editor:not([mini])", {
				"language-rfc:go-to-page": this.goToPage.bind(this),
				"language-rfc:next-page":  this.nextPage.bind(this),
				"language-rfc:prev-page":  this.prevPage.bind(this),
				"language-rfc:open-rfc":   this.openRFC.bind(this),
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
	 * @return {Promise<String>}
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
		return editor;
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

	/**
	 * Open an RFC by number.
	 *
	 * @param {Event|Number} [event=null]
	 * @return {Promise<?TextEditor>}
	 * @private
	 */
	openRFC(event = null){
		// Support programmatic (non-interactive) use
		if("number" === typeof event)
			return atom.workspace.open("rfc:" + event);
		
		return this.prompt("Enter an RFC number").then(value => {
			value = parseInt(value, 10);
			if(value > 0)
				return atom.workspace.open("rfc:" + value);
		});
	},
	
	/**
	 * Download a file.
	 *
	 * @param {String|URL} url - URL of resource to download
	 * @param {String} [writeTo=null] - Filesystem location to save file to
	 * @return {Promise<Buffer>}
	 * @api private
	 */
	async downloadFile(url, writeTo = null){
		const bytes = await fetch(url).then(response => response.arrayBuffer()).then(Buffer.from);
		writeTo && writeFileSync(writeTo, bytes, {encoding: null});
		return bytes;
	},
	
	/**
	 * Handle requests for `rfc:` URLs.
	 *
	 * @param {String} uri
	 * @return {Promise<TextEditor>|void}
	 * @api private
	 */
	handleURI(uri){
		if(!rfcDirectory) return;
		let rfc = NaN;
		let anchor = "";
		const name = basename(uri).replace(/#.*/, match => (anchor = match.slice(1), ""));
		if(!(uri = parseURL(uri)).protocol && /^rfc:\d+/.test(name))
			rfc = parseInt(name.slice(4), 10);
		else if("rfc:" === uri.protocol){
			anchor = uri.hash;
			rfc = parseInt(uri.hostname || uri.path?.replace(/^\//, ""), 10);
		}
		if(!isFinite(rfc)) return;
		
		// Already open in workspace
		const path = join(rfcDirectory, `rfc${rfc}.txt`);
		const item = atom.workspace.getActivePane().itemForURI(path);
		if(item)
			return this.executeAnchorAction(anchor, item);
		
		// RFC already exists locally
		if(isFile(path))
			return atom.workspace.openTextFile(path).then(editor =>
				this.executeAnchorAction(anchor, editor));
		
		// Download RFC file
		if(!atom.config.get("language-rfc.downloadEnabled")) return;
		isDir(rfcDirectory) || mkdirSync(rfcDirectory, {recursive: true});
		return this.downloadFile(atom.config.get("language-rfc.downloadSource").replaceAll("#", rfc), path)
			.then(async () => this.executeAnchorAction(anchor, await atom.workspace.openTextFile(path)))
			.catch(error => atom.workspace.addError("Error caught while downloading RFC", {detail: error}));
	},
	
	/**
	 * Navigate to a section of an opened RFC file specified by a fragment identifer.
	 * @param {String} input
	 * @param {TextEditor} [editor]
	 * @return {TextEditor}
	 * @internal
	 */
	executeAnchorAction(input, editor = atom.workspace.getActiveTextEditor){
		input = `${input}`;
		const section = input.match(/^#?(appendix|section|ref|page)-(?!-)(\S+)$/);
		if(section){
			const type = section[1];
			if("page" === type){
				const page = Math.max(0, parseInt(section[2], 10));
				return isFinite(page) ? this.goToPage(page, editor) : editor;
			}
			const name = RegExp.escape(section[2]);
			const regex = new RegExp({
				appendix: `^ *Appendix +${name}`,
				section:  `^ *${name}\\.? `,
				ref:      `^ +\\[${name}\\] `,
			}[type] || "(?:)", "m");
			const match = editor.buffer.findSync(regex);
			if(match){
				const {start: offset} = Range.fromObject(match);
				editor.setSelectedBufferRange(new Range(offset, offset));
				editor.scrollToBufferPosition(offset, {center: true});
			}
			return editor;
		}
		
		// Line/column range in GitHub's blob-link compatible format (e.g., "#L1-L5")
		const offsets = [];
		for(const [, row, column = row] of input.matchAll(/(?:^#?|(?<=-))L(\d+)(?:C(\d+)\b)?/g))
			if(offsets.push(new Point(
				Math.max(0, parseInt(row,    10) - 1),
				Math.max(0, parseInt(column, 10) - 1),
			)) > 1) break;
		const [start, end = start] = offsets;
		start && editor.setSelectedBufferRange(new Range(start, end));
		return editor;
	},
	
	/**
	 * Perform bash(1)-style tilde expansion on a path.
	 *
	 * @example expandPath("~/Library") === "/Users/Alhadis/Library";
	 * @example expandPath("~root") === "/var/root";
	 * @param {String} path
	 * @return {String}
	 * @api private
	 */
	expandPath(path){
		if(!path) return "";
		const {HOME} = process.env ?? {};
		path = normalize(`${path}`).replace(/\/+$/, "");
		if("~" === path) return HOME;
		if(path.startsWith("~/"))
			path = join(HOME, path.slice(2));
		else if(/^~(?!-|\+)([^/\\]+)/.test(path)){
			const user = RegExp.$1;
			if(user in (this.userList ||= this.loadUserList())){
				const {home} = this.userList[user];
				if(isDir(home))
					path = join(home, path.slice(path.indexOf("/")));
			}
		}
		return path;
	},
	
	/**
	 * Retrieve a list of registered user accounts, keyed by login-name.
	 *
	 * User details are read from the system's passwd(5) file, and (on macOS),
	 * also by consulting DirectoryService(8) via the dscl(1) utility. A value
	 * of `null` is returned if neither approach yields any login data.
	 *
	 * @return {?Object<String, User>}
	 * @api private
	 */
	loadUserList(){
		/**
		 * Details about a registered user's login account.
		 * @typedef User
		 * @property {?Number} lineNumber - Definition line-number
		 * @property {String}  name - Login name
		 * @property {?String} password - Encrypted password (unused)
		 * @property {Number}  uid - User ID
		 * @property {Number}  gid - Group ID
		 * @property {?String} userClass - User classification (unused)
		 * @property {?String} passwordChange - Password change time
		 * @property {?String} passwordExpire - Account expiration time
		 * @property {String}  gecos - Full name
		 * @property {String}  home - Home directory
		 * @property {String}  shell - Login shell
		 */
		const users = {__proto__: null};
		let userCount = 0;
		if(isFile("/etc/passwd")){
			let lineNumber = 0;
			for(const line of readFileSync("/etc/passwd", "utf8").split("\n")){
				++lineNumber;
				if(!line.includes(":") || line.startsWith("#"))
					continue;
				const fields = line.split(":");
				const [name] = fields;
				++userCount;
				users[name] = {
					__proto__: null,
					lineNumber, name,
					password:        fields[1],
					uid:             parseInt(fields[2]),
					gid:             parseInt(fields[3]),
					userClass:       fields[4],
					passwordChange:  fields[5],
					passwordExpire:  fields[6],
					gecos:           fields[7],
					home:            fields[8],
					shell:           fields[9],
				};
			}
		}
		
		// Try and tame macOS's Open Directory system
		if("darwin" === process.platform){
			for(const user of execSync("dscl . -list /Users", {encoding: "utf8"}).trim().split("\n")){
				if(user in users) continue;
				const args = "-plist . -read /Users/ NFSHomeDirectory PrimaryGroupID RealName UniqueID UserShell".split(" ");
				args[3] += user;
				const dscl = spawnSync("dscl", args);
				let {stderr, stdout, status} = dscl;
				if(status){
					stderr = Buffer.from(stderr).toString().trim();
					console.error(stderr || "dscl: exited with error code " + dscl.status);
					continue;
				}
				if(stdout){
					users[user] = this.parseDSRecord(stdout, user);
					++userCount;
				}
			}
		}
		return userCount ? users : null;
	},
	
	/**
	 * Parse an XML property-list returned by macOS's dscl(1) utility.
	 * @param {String|Buffer|Uint8Array} source
	 * @param {String} userName
	 * @return {User}
	 * @api private
	 */
	parseDSRecord(source, userName){
		if(source instanceof Uint8Array)
			source = Buffer.from(source);
		source = `${source}`.trim();
		
		const xml = new DOMParser().parseFromString(source, "text/xml");
		const user = {__proto__: null, name: userName};
		let key, value;
		for(const el of xml.documentElement.firstElementChild.children){
			if("key" === el.tagName){
				if(null != key) throw new SyntaxError("<key> element found where value expected");
				key = el.textContent.trim().replace(/^dsAttrTypeStandard:/, "");
			}
			else{
				switch(el.tagName){
					case "string":
						value = [el]; // Fall-through
					case "array":
						value = Array.from(el.children).map(el => el.textContent);
						if(value.length < 2)
							[value = null] = value;
						break;
					default:
						throw new TypeError("Unsupported value type: " + el.tagName);
				}
				switch(key || null){
					case "PrimaryGroupID":   key = "gid";  value = parseInt(value); break;
					case "UniqueID":         key = "uid";  value = parseInt(value); break;
					case "NFSHomeDirectory": key = "home";  break;
					case "UserShell":        key = "shell"; break;
					case "RealName":         key = "gecos"; break;
					case null:
						throw new SyntaxError("No key defined for value: " + value);
				}
				user[key] = value;
				key = value = undefined;
			}
		}
		return user;
	},
};

/** Polyfill for {@linkcode RegExp.escape|https://tc39.es/ecma262/multipage/text-processing.html#sec-regexp.escape}. */
if("function" !== typeof RegExp.escape)
	Object.defineProperty(RegExp, "escape", {
		configurable: true,
		writable: true,
		value: function escape(string){
			if("string" !== typeof string)
				throw new TypeError("Input is not a string");
			const esc = "\\";
			const shortEsc = {0x09: "t", 0x0A: "n", 0x0B: "v", 0x0C: "f", 0x0D: "r"};
			const escapeCode = char => {
				let code = char.codePointAt(0);
				if(code in shortEsc) return esc + shortEsc[code];
				if(code <= 0xFF)     return esc + "x" + code.toString(16).padStart(2, "0");
				if(code <= 0xFFFF)   return esc + "u" + code.toString(16).padStart(4, "0");
				if(code <= 0x10FFFF) return (
					esc + "u" + (Math.floor((code - 0x10000) / 0x400) + 0xD800).padStart(4, "0") +
					esc + "u" + (((code - 0x10000) % 0x400) + 0xDC00).padStart(4, "0")
				);
				code = code.toString(16).toUpperCase();
				throw new RangeError(`Illegal code point: U+${code}`);
			};
			return string
				.replace(/[[\]$\\.*+?(){}|^]/g,                  esc + "$&")
				.replace(/^[0-9a-zA-Z]/,                         escapeCode)
				.replace(/[-,=<>#&!%:;@~'` "\f\n\r\t\v]/g,       escapeCode)
				.replace(/[\x85\p{Zl}\p{Zp}]/gu,                 escapeCode)
				.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g,  escapeCode)
				.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, escapeCode);
		},
	});


// Circuitous hack to fix display of package's preview-images whilst retaining
// the 72 character line-length limit imposed upon the `README.md` file.
const atomPath = dirname(require.resolve("atom"));
const PackageDetailView = require(resolve(atomPath, "../node_modules/settings-view/lib/package-detail-view"));
const isRFCPkg = x => atom.packages.loadedPackages["language-rfc"] === x.pack;
const {completeInitialization, renderReadme} = PackageDetailView.prototype;
Object.assign(PackageDetailView.prototype, {
	completeInitialization(...args){
		if(isRFCPkg(this)){
			const repoURL = "https://raw.githubusercontent.com/Alhadis/language-rfc/18b6cc0bfd787b542d6a8d5af109045f2b183df2/";
			this.readmePath = join(this.pack.path, "README.md");
			this.readme = this.pack.metadata.readme = readFileSync(this.readmePath, "utf8").replace(
				/\s(srcset|src)\s*=\s*("|')\.\.\/18b6cc0\/(preview-(?:light|dark)\.png)\2/gi,
				` $1=$2${repoURL}$3$2`,
			);
		}
		const result = completeInitialization.apply(this, args);
		if(isRFCPkg(this)){
			const title = this.refs.title?.childNodes[0];
			const index = title.textContent.indexOf(" Rfc");
			~index && title.replaceData(index, 5, " RFC");
		}
		return result;
	},
	renderReadme(...args){
		const result = renderReadme.apply(this, args);
		if(isRFCPkg(this)){
			const {element} = this.readmeView;
			const preview = element.querySelector("source:first-child + img:last-child");
			if(preview){
				const {parentElement} = preview;
				const picture = document.createElement("picture");
				picture.append(...parentElement.childNodes);
				parentElement.replaceWith(picture);
			}
		}
		return result;
	},
});
Object.defineProperty(module.exports, "readmeHack", {value: new Disposable(() =>
	Object.assign(PackageDetailView.prototype, {completeInitialization, renderReadme}))});
