/* odds.js is a UMD file shared with the node tests. Imported as a module its
 * root is self, so the side effect leaves GPE_ODDS on the page; hand it on. */
import "../../../odds.js";

export default self.GPE_ODDS;
