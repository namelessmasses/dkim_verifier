/*
 * DNS LIBRARY IN JAVASCRIPT
 *
 * Copyright 2005 Joshua Tauberer <http://razor.occams.info>
 *
 * Feel free to use this file however you want, but
 * credit would be nice.
 *
 * A major limitation of this library is that Mozilla
 * only provides TCP sockets, and DNS servers sometimes
 * only respond on UDP. Especially public DNS servers
 * that have the authoritative information for their
 * domain. In that case, we really need a "local" server
 * that responds to TCP.
 *
 * We have a few options.  First, we could try the public
 * DNS system starting at one of the root servers of the
 * world and hope the name servers on the path to the final
 * answer all respond to TCP. For that, the root name server
 * could be, e.g., J.ROOT-SERVERS.NET.
 *
 * Or we can just go with Google's new public DNS service
 * at 8.8.8.8 or 8.8.4.4 which responds on TCP. Good solution!
 *
 * The next option is to ask the user for a local name server
 * that responds to TCP. Some routers cause trouble for this.
 * It would be nice to have a local server so that it caches
 * nicely. The user can override the otherwise default root
 * server by setting the dns.nameserver option.
 *
 * We can also try to auto-detect the user's local name server.
 * The Windows registry and the file /etc/resolv.conf (on Linux)
 * can be scanned for a DNS server to use.
 */

/*
 * Original from "Sender Verification Extension" version 0.9.0.6
 * Modified by Philippe Lieser for "DKIM Verifier" version 0.5.1
 *
 * Modifications:
 *  since version 0.3.0
 *   - changed to a JavaScript code module
 *   - DNS_LoadPrefs() not executed
 *   - added debug on/off setting
 *  since version 0.3.4
 *   - CNAME record type partial supported
 *    - doesn't throw a exception anymore
 *    - data not read, and not included in the returned result
 *  since version 0.5.0
 *   - added support of multiple DNS servers
 *  since version 0.5.1
 *   - reenabled support to get DNS Servers from OS
 *    - modified and renamed DNS_LoadPrefs() to DNS_get_OS_DNSServers()
 *   - fixed jshint errors/warnings
 *  since version 0.6.1
 *   - better detection of configured DNS Servers in Windows
 *  since version 0.6.3
 *   - fixed bug for detection of configured DNS Servers in Windows
 *     (if more then one DNS server was configured for an adapter)
 */

// options for JSHint
/* jshint -W064 */ //"Missing 'new' prefix when invoking a constructor."
/* jshint unused:true */ // allow unused parameters that are followed by a used parameter.
/* global Components, DNS_STRINGS */
/* exported EXPORTED_SYMBOLS, dnsChangeGetNameserversFromOS, dnsChangeNameserver, dnsChangeDebug, dnsChangeTimeoutConnect, reverseDNS, DNS_Test */


var EXPORTED_SYMBOLS = [
	"queryDNS",
	"dnsChangeGetNameserversFromOS",
	"dnsChangeNameserver",
	"dnsChangeDebug",
	"dnsChangeTimeoutConnect"
];
// load locale strings
Components.utils.import("chrome://dkim_verifier/locale/dns.js");

/* structur of DNS_ROOT_NAME_SERVERS, PREF_DNS_ROOT_NAME_SERVERS, OS_DNS_ROOT_NAME_SERVERS:
	DNS_ROOT_NAME_SERVERS = [
		{
			server : "8.8.8.8",
			alive : "true"
		}
	];
*/
var DNS_ROOT_NAME_SERVERS = [];
var PREF_DNS_ROOT_NAME_SERVERS = [];
var OS_DNS_ROOT_NAME_SERVERS = [];

// Preferences
var getNameserversFromOS = null;
var dnsDebug = false;
var timeout_connect = 0xFFFF;

/*
 * Changes preference getNameserversFromOS and updates DNS Servers
 *
 * @param {Boolean} bool
 * @return {Undefined}
 */
function dnsChangeGetNameserversFromOS(bool) {
	"use strict";

	getNameserversFromOS = bool;
	
	if (getNameserversFromOS) {
		DNS_get_OS_DNSServers();
		DNS_ROOT_NAME_SERVERS = arrayUniqBy(
			OS_DNS_ROOT_NAME_SERVERS.concat(PREF_DNS_ROOT_NAME_SERVERS),
			function(e) {return e.server;}
		);
	} else {
		DNS_ROOT_NAME_SERVERS = PREF_DNS_ROOT_NAME_SERVERS;
	}

	DNS_Debug("DNS: changed DNS Servers to : " + DNS_ROOT_NAME_SERVERS.toSource());
}

/*
 * Changes preference DNS Servers and updates DNS Servers
 *
 * @param {String} nameserver
 *        ";" separated list of DNS Nameservers
 * @return {Undefined}
 */
function dnsChangeNameserver(nameserver) {
	"use strict";
	
	var nameservers = nameserver.split(";");
	PREF_DNS_ROOT_NAME_SERVERS = [];
	nameservers.forEach(function(element /*, index, array*/) {
		if (element.trim() !== "") {
			PREF_DNS_ROOT_NAME_SERVERS.push({
				server : element.trim(),
				alive : true
			});
		}
	});
	//DNS_Debug("DNS: Got servers from user preference: " + PREF_DNS_ROOT_NAME_SERVERS.toSource());

	if (getNameserversFromOS) {
		DNS_get_OS_DNSServers();
		DNS_ROOT_NAME_SERVERS = arrayUniqBy(
			OS_DNS_ROOT_NAME_SERVERS.concat(PREF_DNS_ROOT_NAME_SERVERS),
			function(e) {return e.server;}
		);
	} else {
		DNS_ROOT_NAME_SERVERS = PREF_DNS_ROOT_NAME_SERVERS;
	}

	DNS_Debug("DNS: changed DNS Servers to : " + DNS_ROOT_NAME_SERVERS.toSource());
}

/*
 * Changes preference dnsDebug
 *
 * @param {Boolean} debug
 * @return {Undefined}
 */
function dnsChangeDebug(debug) {
	"use strict";
	
	dnsDebug = debug;
}

/*
 * Changes preference timeout_connect
 *
 * @param {Number} timeout
 *        Timeout in seconds
 * @return {Undefined}
 */
function dnsChangeTimeoutConnect(timeout) {
	"use strict";
	
	timeout_connect = timeout;
}

/*
 * Remove Duplicates from Array
 *
 * from http://stackoverflow.com/questions/9229645/remove-duplicates-from-javascript-array/9229821#9229821
 *
 * @param {Array} ary
 * @param {Function} key
 *        Function to generate key from element
 */
function arrayUniqBy(ary, key) {
	"use strict";
	
    var seen = {};
    return ary.filter(function(elem) {
        var k = key(elem);
        return (seen[k] === 1) ? 0 : seen[k] = 1;
    });
}

/*
 * get DNS Servers from OS configuration
 *
 * @return {Undefined}
 */
function DNS_get_OS_DNSServers() {
	"use strict";
	
	OS_DNS_ROOT_NAME_SERVERS = [];

	if ("@mozilla.org/windows-registry-key;1" in Components.classes) {
		// Firefox 1.5 or newer on Windows
		// Try getting a nameserver from the windows registry
		try {
			var registry_class = Components.classes["@mozilla.org/windows-registry-key;1"];
			var registry_object = registry_class.createInstance();
			var registry = registry_object.QueryInterface(Components.interfaces.nsIWindowsRegKey);
			
			registry.open(registry.ROOT_KEY_LOCAL_MACHINE,
				"SYSTEM\\CurrentControlSet\\Services\\Tcpip",
				registry.ACCESS_QUERY_VALUE);
			
			// get interfaces in routing order
			var registryLinkage = registry.openChild("Linkage", registry.ACCESS_READ);
			// nsIWindowsRegKey doesn't support REG_MULTI_SZ type out of the box
			// from http://mxr.mozilla.org/comm-central/source/mozilla/browser/components/migration/src/IEProfileMigrator.js#129
			// slice(1,-1) to remove the " at the beginning and end
			var str = registryLinkage.readStringValue("Route");
			var interfaces = [v.slice(1,-1) for (v of str.split("\0")) if (v)];
			registryLinkage.close();
			
			// get NameServer and DhcpNameServer of all interfaces
			var registryInterfaces = registry.openChild(
				"Parameters\\Interfaces",
				registry.ACCESS_READ
			);
			var reg;
			var ns = "";
			for (var i=0; i < interfaces.length; i++) {
				reg = registryInterfaces.openChild(
					interfaces[i],
					registry.ACCESS_READ
				);
				if (reg.hasValue("NameServer")) {
					ns += " " + reg.readStringValue("NameServer");
				}
				if (reg.hasValue("DhcpNameServer")) {
					ns += " " + reg.readStringValue("DhcpNameServer");
				}
				reg.close();
			}
			registryInterfaces.close();
			
			registry.close();
			
			if (ns !== "") {
				var servers = ns.split(/ |,/);
				servers.forEach(function(element /*, index, array*/) {
					if (element !== "") {
						OS_DNS_ROOT_NAME_SERVERS.push({
							server : element.trim(),
							alive : true
						});
					}
				});
				DNS_Debug("DNS: Got servers from Windows registry: " +
					OS_DNS_ROOT_NAME_SERVERS.toSource());
			}
		} catch (e) {
			DNS_Debug("DNS: Reading Registry: " + e + "\n" + e.stack);
		}
	} else {
		// Try getting a nameserver from /etc/resolv.conf.
		try {
			var resolvconf = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsILocalFile);
			resolvconf.initWithPath("/etc/resolv.conf");
			
			var stream = Components.classes["@mozilla.org/network/file-input-stream;1"].createInstance();
			var stream_filestream = stream.QueryInterface(Components.interfaces.nsIFileInputStream);
			stream_filestream.init(resolvconf, 0, 0, 0); // don't know what the flags are...
			
			var stream_reader = stream.QueryInterface(Components.interfaces.nsILineInputStream);
			
			var out_line = {};
			while (stream_reader.readLine(out_line)) {
				if (DNS_StartsWith(out_line.value, "nameserver ")) {
					OS_DNS_ROOT_NAME_SERVERS.push({
						server : out_line.value.substring("nameserver ".length).trim(),
						alive : true
					});
				}
			}
			
			stream_filestream.close();
			
			DNS_Debug("DNS: Got servers from resolv.conf: " + OS_DNS_ROOT_NAME_SERVERS.toSource());
		} catch (e) {
			DNS_Debug("DNS: Reading resolv.conf: " + e + "\n" + e.stack);
		}
	}
	
	//DNS_Debug("DNS: Autoconfigured servers: " + OS_DNS_ROOT_NAME_SERVERS);
}

var dns_test_domains = Array("for.net", "www.for.net", "yy.for.net", "www.gmail.net");
var dns_test_domidx = 0;
//DNS_Test();
function DNS_Test() {
	"use strict";
	
	queryDNS(dns_test_domains[dns_test_domidx], "MX",
		function(data) {
			var str;
			var i;
			if (data === null) { str = "no data"; }
			else {
				for (i = 0; i < data.length; i++) {
					if (data[i].host !== null) {
						data[i] = "host=" + data[i].host + ";address=" + data[i].address;
					}
					
					if (str !== null) {
						str += ", ";
					} else {
						str = "";
					}
					str += data[i];
				}
			}
			
			DNS_Debug("DNS_Test: " + dns_test_domains[dns_test_domidx] + " => " + str);
			dns_test_domidx++;
			DNS_Test();
		} );
}

//queryDNS("www.example.com", "A", function(data) { alert(data); } );
//reverseDNS("123.456.789.123", function(addrs) { for (var i = 0; i < addrs.length; i++) { alert(addrs[i]); } } );

// queryDNS: This is the main entry point for external callers.
function queryDNS(host, recordtype, callback, callbackdata) {
	"use strict";
	
	queryDNSRecursive(null, host, recordtype, callback, callbackdata, 0, DNS_ROOT_NAME_SERVERS);
}

function reverseDNS(ip, callback, callbackdata) {
	"use strict";
	
	// Get a list of reverse-DNS hostnames,
	// and then make sure that each hostname
	// resolves to the original IP.
	
	queryDNS(DNS_ReverseIPHostname(ip), "PTR",
		function(hostnames, mydata, queryError) {
			// No reverse DNS info available.
			if (hostnames === null) { callback(null, callbackdata, queryError); return; }
			
			var obj = {};
			obj.ret = Array(0);
			obj.retctr = 0;
			obj.resolvectr = 0;
			
			var i;
			
			// Check that each one resolves forward.
			for (i = 0; i < hostnames.length; i++) {
				var o2 = {};
				o2.retobj = obj;
				o2.curhostname = hostnames[i];
				
				queryDNS(hostnames[i], "A",
				function(arecs, cb) {
					var matched;
					if (arecs !== null) {
						var j;
						matched = false;
						for (j = 0; j < arecs.length; j++) {
							if (arecs[j] === ip) { matched = true; break; }
						}
					}
					
					if (matched) {
						cb.retobj.ret[cb.retobj.retctr++] = cb.curhostname;
					}
					
					if (++cb.retobj.resolvectr === hostnames.length) {
						if (cb.retobj.retctr === 0) {
							callback(null, callbackdata);
						} else {
							callback(cb.retobj.ret, callbackdata);
						}
					}
				}, o2);
			}
		});
}

function DNS_ReverseIPHostname(ip) {
	"use strict";
	
	var q = ip.split(".");
	return q[3] + "." + q[2] + "." + q[1] + "." + q[0] + ".in-addr.arpa";
}

function queryDNSRecursive(server, host, recordtype, callback, callbackdata, hops, servers) {
	"use strict";
	
	// if more when one server is given
	if (servers !== undefined) {
		// set server to next alive DNS server
		var i;
		var serverObj = null;
		server = null;
		for (i = 0; i < servers.length; i++) {
			if (servers[i].alive) {
				server = servers[i].server;
				serverObj = servers[i];
				break;
			}
		}
		
		if (server === null) {
			DNS_Debug("DNS: no DNS Server alive");
			callback(null, callbackdata, "no DNS Server alive");
			return;
		}
	}

	if (hops === 10) {
		DNS_Debug("DNS: Maximum number of recursive steps taken in resolving " + host);
		callback(null, callbackdata, DNS_STRINGS.TOO_MANY_HOPS);
		return;
	}
	
	DNS_Debug("DNS: Resolving " + host + " " + recordtype + " by querying " + server);
		
	var query =
		// HEADER
		"00" + // ID
		String.fromCharCode(1) + // QR=0, OPCODE=0, AA=0, TC=0, RD=1 (Recursion desired)
		String.fromCharCode(0) + // all zeroes
		DNS_wordToStr(1) + // 1 query
		DNS_wordToStr(0) + // ASCOUNT=0
		DNS_wordToStr(0) + // NSCOUNT=0
		DNS_wordToStr(0) // ARCOUNT=0
		;
		
	var hostparts = host.split(".");
	for (var hostpartidx = 0; hostpartidx < hostparts.length; hostpartidx++) {
		query += DNS_octetToStr(hostparts[hostpartidx].length) + hostparts[hostpartidx];
	}
	query += DNS_octetToStr(0);
	if (recordtype === "A") {
		query += DNS_wordToStr(1);
	} else if (recordtype === "NS") {
		query += DNS_wordToStr(2); 
	} else if (recordtype === "CNAME") {
		query += DNS_wordToStr(5); 
	} else if (recordtype === "PTR") {
		query += DNS_wordToStr(12); 
	} else if (recordtype === "MX") {
		query += DNS_wordToStr(15); 
	} else if (recordtype === "TXT") {
		query += DNS_wordToStr(16); 
	} else {
		throw "Invalid record type.";
	}
	query += DNS_wordToStr(1); // IN
		
	// Prepend query message length
	query = DNS_wordToStr(query.length) + query;
	
	var listener = {
		msgsize : null,
		readcount : 0,
		responseHeader : "",
		responseBody : "",
		done : false,
		finished : function(data, status) {
			if (status !== 0) {
				if (status === 2152398861) {
					DNS_Debug("DNS: Resolving " + host + "/" + recordtype + ": DNS server " + server + " refused a TCP connection.");
					if (servers === undefined) {
						callback(null, callbackdata, DNS_STRINGS.CONNECTION_REFUSED(server));
					}
				} else if (status === 2152398868) {
					DNS_Debug("DNS: Resolving " + host + "/" + recordtype + ": DNS server " + server + " timed out on a TCP connection.");
					if (servers === undefined) {
						callback(null, callbackdata, DNS_STRINGS.TIMED_OUT(server));
					}
				} else if (status === Components.results.NS_ERROR_NET_TIMEOUT) {
					DNS_Debug("DNS: Resolving " + host + "/" + recordtype + ": DNS server " + server + " timed out on a TCP connection (NS_ERROR_NET_TIMEOUT).");
					if (servers === undefined) {
						callback(null, callbackdata, DNS_STRINGS.TIMED_OUT(server));
					}
				} else {
					DNS_Debug("DNS: Resolving " + host + "/" + recordtype + ": Failed to connect to DNS server " + server + " with error code " + status + ".");
					if (servers === undefined) {
						callback(null, callbackdata, DNS_STRINGS.SERVER_ERROR(server));
					}
				}
				
				// if more when one server is given
				if (servers !== undefined) {
					// set current server to not alive
					serverObj.alive = false;
					
					// start query again for next server
					queryDNSRecursive(null, host, recordtype, callback, callbackdata, hops, servers);
				}
				return;
			}
			
			this.process(data);
			if (!this.done) {
				DNS_Debug("DNS: Resolving " + host + "/" + recordtype + ": Response was incomplete.");
				callback(null, callbackdata, DNS_STRINGS.INCOMPLETE_RESPONSE(server));
			}
		},
		process : function(data){
			if (this.done) {
				return false;
			}
			
			this.readcount += data.length;
			
			while (this.responseHeader.length < 14 && data.length > 0) {
				this.responseHeader += data.charAt(0);
				data = data.substr(1);
			}
			if (this.responseHeader.length === 14) {
				this.msgsize = DNS_strToWord(this.responseHeader.substr(0, 2));
				this.responseBody += data;

				//DNS_Debug("DNS: Received Reply: " + (this.readcount-2) + " of " + this.msgsize + " bytes");

				if (this.readcount >= this.msgsize+2) {
					this.responseHeader = this.responseHeader.substr(2); // chop the length field
					this.done = true;
					DNS_getRDData(this.responseHeader + this.responseBody, server, host, recordtype, callback, callbackdata, hops);
					return false;
				}
			}
			return true;
		}
	};
	
	// allow server to be either a hostname or hostname:port
	var server_hostname = server;
	var port = 53;
	if (server.indexOf(':') !== -1) {
		server_hostname = server.substring(0, server.indexOf(':'));
		port = server.substring(server.indexOf(':')+1);
	}

	var ex = DNS_readAllFromSocket(server_hostname, port, query, listener);
	if (ex !== null) {
		DNS_Debug("DNS: " + ex + "\n" + ex.stack);
	}
}

function DNS_readDomain(ctx) {
	"use strict";
	
	var domainname = "";
	var ctr = 20;
	while (ctr-- > 0) {
		var l = ctx.str.charCodeAt(ctx.idx++);
		if (l === 0) {
			break;
		}
		
		if (domainname !== "") {
			domainname += ".";
		}
		
		/* jshint -W016 */ // "Unexpected use of '{a}'."
		if ((l >> 6) === 3) {
			// Pointer
			var ptr = ((l & 63) << 8) + ctx.str.charCodeAt(ctx.idx++);
			var ctx2 = { str : ctx.str, idx : ptr };
			domainname += DNS_readDomain(ctx2);
			break;
		} else {
			domainname += ctx.str.substr(ctx.idx, l);
			ctx.idx += l;
		}
		/* jshint +W016 */
	}
	return domainname;
}

function DNS_readRec(ctx) {
	"use strict";
	
	var rec = {};
	var ctr;
	var txtlen;
	
	rec.dom = DNS_readDomain(ctx);
	rec.type = DNS_strToWord(ctx.str.substr(ctx.idx, 2)); ctx.idx += 2;
	rec.cls = DNS_strToWord(ctx.str.substr(ctx.idx, 2)); ctx.idx += 2;
	rec.ttl = DNS_strToWord(ctx.str.substr(ctx.idx, 2)); ctx.idx += 4; // 32bit
	rec.rdlen = DNS_strToWord(ctx.str.substr(ctx.idx, 2)); ctx.idx += 2;
	rec.recognized = 1;
	
	var ctxnextidx = ctx.idx + rec.rdlen;
	
	if (rec.type === 16) {
		rec.type = "TXT";
		rec.rddata = "";
		ctr = 10;
		while (rec.rdlen > 0 && ctr-- > 0) {
			txtlen = DNS_strToOctet(ctx.str.substr(ctx.idx,1)); ctx.idx++; rec.rdlen--;
			rec.rddata += ctx.str.substr(ctx.idx, txtlen); ctx.idx += txtlen; rec.rdlen -= txtlen;
		}
	} else if (rec.type === 1) {
		// Return as a dotted-quad
		rec.type = "A";
		rec.rddata = ctx.str.substr(ctx.idx, rec.rdlen);
		rec.rddata = rec.rddata.charCodeAt(0) + "." + rec.rddata.charCodeAt(1) + "." + rec.rddata.charCodeAt(2) + "." + rec.rddata.charCodeAt(3);
	} else if (rec.type === 15) {
		rec.type = "MX";
		rec.rddata = {};
		rec.rddata.preference = DNS_strToWord(ctx.str.substr(ctx.idx,2)); ctx.idx += 2;
		rec.rddata.host = DNS_readDomain(ctx);
	} else if (rec.type === 2) {
		rec.type = "NS";
		rec.rddata = DNS_readDomain(ctx);
	} else if (rec.type === 12) {
		rec.type = "PTR";
		rec.rddata = DNS_readDomain(ctx);
	} else if (rec.type === 5) {
		rec.type = "CNAME";
		// no complete support of CNAME (data is not read)
		rec.rddata = "";
	} else {
		rec.recognized = 0;
	}
	
	ctx.idx = ctxnextidx;
	
	return rec;
}

function DNS_getRDData(str, server, host, recordtype, callback, callbackdata, hops) {
	"use strict";
	
	var qcount = DNS_strToWord(str.substr(4, 2));
	var ancount = DNS_strToWord(str.substr(6, 2));
	var aucount = DNS_strToWord(str.substr(8, 2));
	var adcount = DNS_strToWord(str.substr(10, 2));
	
	var ctx = { str : str, idx : 12 };
	
	var i;
	var j;
	var dom;
	var type;
	var cls;
	// var ttl;
	var rec;
	
	if (qcount !== 1) {
		throw "Invalid response: Question section didn't have exactly one record.";
	}
	if (ancount > 128) {
		throw "Invalid response: Answer section had more than 128 records.";
	}
	if (aucount > 128) {
		throw "Invalid response: Authority section had more than 128 records.";
	}
	if (adcount > 128) {
		throw "Invalid response: Additional section had more than 128 records.";
	}
	
	for (i = 0; i < qcount; i++) {
		dom = DNS_readDomain(ctx);
		type = DNS_strToWord(str.substr(ctx.idx, 2)); ctx.idx += 2;
		cls = DNS_strToWord(str.substr(ctx.idx, 2)); ctx.idx += 2;
	}
	
	var debugstr = "DNS: " + host + "/" + recordtype + ": ";
	
	var results = [];
	for (i = 0; i < ancount; i++) {
		rec = DNS_readRec(ctx);
		if (!rec.recognized) {
			throw "Record type is not one that this library can understand.";
		}
		// ignore CNAME records
		if (rec.type !== "CNAME") {
			results.push(rec.rddata);
		} else {
			DNS_Debug(debugstr + "CNAME ignored :" + rec.rddata);
		}
		DNS_Debug(debugstr + "Answer: " + rec.rddata);
	}

	var authorities = Array(aucount);
	for (i = 0; i < aucount; i++) {
		rec = DNS_readRec(ctx);
		authorities[i] = rec;
		if (rec.recognized) {
			DNS_Debug(debugstr + "Authority: " + rec.type + " " + rec.rddata);
		}
		// Assuming the domain for this record is the domain we are asking about.
	}
	
	for (i = 0; i < adcount; i++) {
		rec = DNS_readRec(ctx);
		if (rec.recognized) {
			DNS_Debug(debugstr + "Additional: " + rec.dom + " " + rec.type + " " + rec.rddata);
		}
		if (rec.type === "A") {
			for (j = 0; j < results.length; j++) {
				if (results[j].host && results[j].host === rec.dom) {
					if (results[j].address === null) {
						results[j].address = Array(0);
					}
					results[j].address[results[j].address.length] = rec.rddata;
				}
			}
		}
	}
	
	if (results.length > 0) {
		// We have an answer.
		callback(results, callbackdata);
		
	} else {
		// No answer.  If there is an NS authority, recurse.
		// Note that we can do without the IP address of the NS authority (given in the additional
		// section) because we're able to do DNS lookups without knowing the IP address
		// of the DNS server -- Thunderbird and the OS take care of that.
		for (i = 0; i < aucount; i++) {
			if (authorities[i].type === "NS" && authorities[i].rddata !== server) {
				DNS_Debug(debugstr + "Recursing on Authority: " + authorities[i].rddata);
				queryDNSRecursive(authorities[i].rddata, host, recordtype, callback, callbackdata, hops+1);
				return;
			}
		}

		// No authority was able to help us.
		DNS_Debug(debugstr + "No answer, no authority to recurse on.  DNS lookup failed.");
		callback(null, callbackdata);
	}
}

function DNS_strToWord(str) {
	"use strict";
	
	/* jshint -W016 */ // "Unexpected use of '{a}'."
	var res = str.charCodeAt(1) + (str.charCodeAt(0) << 8);
	/* jshint +W016 */
	return res;
}

function DNS_strToOctet(str) {
	"use strict";
	
	return str.charCodeAt(0);
}

function DNS_wordToStr(word) {
	"use strict";
	
	/* jshint -W016 */ // "Unexpected use of '{a}'."
	var res = DNS_octetToStr((word >> 8) % 256) + DNS_octetToStr(word % 256);
	/* jshint +W016 */
	return res;
}

function DNS_octetToStr(octet) {
	"use strict";
	
	return String.fromCharCode(octet);
}

// This comes from http://xulplanet.com/tutorials/mozsdk/sockets.php

function DNS_readAllFromSocket(host,port,outputData,listener)
{
	"use strict";
	
	try {
		var transportService =
			Components.classes["@mozilla.org/network/socket-transport-service;1"]
			.getService(Components.interfaces.nsISocketTransportService);
		
		var transport = transportService.createTransport(null,0,host,port,null);

		// change timeout for connection
		transport.setTimeout(transport.TIMEOUT_CONNECT, timeout_connect);
		
		var outstream = transport.openOutputStream(0,0,0);
		outstream.write(outputData,outputData.length);

		var stream = transport.openInputStream(0,0,0);
		var instream = Components.classes["@mozilla.org/binaryinputstream;1"]
			.createInstance(Components.interfaces.nsIBinaryInputStream);
		instream.setInputStream(stream);

		var dataListener = {
			data : "",
			onStartRequest: function(/* request, context */){},
			onStopRequest: function(request, context, status){
				if (listener.finished !== null) {
					listener.finished(this.data, status);
				}
				outstream.close();
				stream.close();
				//DNS_Debug("DNS: Connection closed (" + host + ")");
			},
			onDataAvailable: function(request, context, inputStream, offset, count){
				//DNS_Debug("DNS: Got data (" + host + ")");
				for (var i = 0; i < count; i++) {
					this.data += String.fromCharCode(instream.read8());
				}
				if (listener.process !== null) {
					if (!listener.process(this.data)) {
						outstream.close();
						stream.close();
					}
					this.data = "";
				}
			}
		};
		
		var pump = Components.
			classes["@mozilla.org/network/input-stream-pump;1"].
			createInstance(Components.interfaces.nsIInputStreamPump);
		pump.init(stream, -1, -1, 0, 0, false);
		pump.asyncRead(dataListener,null);
	} catch (ex) {
		return ex;
	}
	return null;
}

function DNS_Debug(message) {
	"use strict";
	
	if (dnsDebug) {
		DNS_Log(message);
	}
}

function DNS_Log(message) {
	"use strict";
	
	var consoleService = Components.classes["@mozilla.org/consoleservice;1"].getService(Components.interfaces.nsIConsoleService);
	consoleService.logStringMessage(message);
}

function DNS_StartsWith(a, b) {
	"use strict";
	
	if (b.length > a.length) {
		return false;
	}
	return a.substring(0, b.length) === b;
}

function DNS_IsDottedQuad(ip) {
	"use strict";
	
	var q = ip.split(".");
	if (q.length !== 4) {
		return false;
	}
	if (isNaN(parseInt(q[0], 10)) || isNaN(parseInt(q[1], 10)) ||
		isNaN(parseInt(q[2], 10)) || isNaN(parseInt(q[3], 10)))
	{
		return false;
	}
	return true;
}
