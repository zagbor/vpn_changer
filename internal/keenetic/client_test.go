package keenetic

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestAuthChallengeResponse verifies the challenge-response handshake flow.
func TestAuthChallengeResponse(t *testing.T) {
	const (
		realm    = "Keenetic"
		chall    = "abc123"
		login    = "admin"
		password = "secret"
		cookie   = "session=xyz"
	)
	var authed bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/auth" && r.Method == http.MethodGet:
			w.Header().Set("x-ndm-realm", realm)
			w.Header().Set("x-ndm-challenge", chall)
			w.Header().Set("set-cookie", cookie+"; Path=/")
			w.WriteHeader(http.StatusUnauthorized)
		case r.URL.Path == "/auth" && r.Method == http.MethodPost:
			var body struct {
				Login    string `json:"login"`
				Password string `json:"password"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if r.Header.Get("Cookie") != cookie {
				t.Errorf("expected cookie %q got %q", cookie, r.Header.Get("Cookie"))
			}
			authed = body.Login == login && body.Password != ""
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, login, password, true)
	if err := c.Auth(); err != nil {
		t.Fatalf("Auth() error: %v", err)
	}
	if !authed {
		t.Fatal("expected router to accept POST /auth")
	}
}

// TestImportWireGuardPayload verifies base64 import body is well-formed.
func TestImportWireGuardPayload(t *testing.T) {
	conf := "[Interface]\nPrivateKey = aaa\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = bbb\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0\n"
	var gotImport string
	var gotFilename string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.URL.Path == "/rci/interface/wireguard/import" && r.Method == http.MethodPost {
			var body struct {
				Import   string `json:"import"`
				Filename string `json:"filename"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			gotImport = body.Import
			gotFilename = body.Filename
			w.Write([]byte(`[]`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "admin", "secret", true)
	if err := c.ImportWireGuard([]byte(conf), "myvpn.conf"); err != nil {
		t.Fatalf("ImportWireGuard error: %v", err)
	}
	decoded, _ := base64.StdEncoding.DecodeString(gotImport)
	if string(decoded) != conf {
		t.Errorf("import payload mismatch:\n got %q\nwant %q", decoded, conf)
	}
	if gotFilename != "myvpn.conf" {
		t.Errorf("filename = %q, want myvpn.conf", gotFilename)
	}
}

// TestParseConf ensures .conf parser extracts Peer params.
func TestParseConf(t *testing.T) {
	conf := "[Interface]\nPrivateKey = aaa\nAddress = 10.0.0.2/32\n\n[Peer]\nPublicKey = bbb\nEndpoint = 1.2.3.4:51820\nPresharedKey = psk\nPersistentKeepalive = 25\nAllowedIPs = 0.0.0.0/0, ::/0\n"
	_, peer, err := parseConf([]byte(conf))
	if err != nil {
		t.Fatalf("parseConf error: %v", err)
	}
	if peer.PublicKey != "bbb" {
		t.Errorf("public key = %q want bbb", peer.PublicKey)
	}
	if peer.Endpoint != "1.2.3.4:51820" {
		t.Errorf("endpoint = %q", peer.Endpoint)
	}
	if peer.Preshared != "psk" {
		t.Errorf("preshared = %q", peer.Preshared)
	}
	if peer.KeepAlive != 25 {
		t.Errorf("keepalive = %d want 25", peer.KeepAlive)
	}
	if len(peer.AllowedIPs) != 2 || !strings.Contains(peer.AllowedIPs[0], "0.0.0.0") {
		t.Errorf("allowed ips = %v", peer.AllowedIPs)
	}
}

// TestShowWireGuardInterfaces verifies we parse and filter interface list JSON.
func TestShowWireGuardInterfaces(t *testing.T) {
	body := `{"interface":[
		{"id":"Wireguard0","type":"wireguard","name":"vpn","state":"up"},
		{"id":"Wireguard1","type":"wireguard","name":"vpn2","state":"down"},
		{"id":"GigabitEthernet0","type":"ethernet","name":"lan"}
	]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.URL.Path == "/rci/show/interface" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(body))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "admin", "x", true)
	ifaces, err := c.ShowWireGuardInterfaces()
	if err != nil {
		t.Fatalf("ShowWireGuardInterfaces error: %v", err)
	}
	if len(ifaces) != 2 {
		t.Fatalf("expected 2 wireguard ifaces, got %d: %+v", len(ifaces), ifaces)
	}
	if ifaces[0].ID != "Wireguard0" || ifaces[0].State != "up" {
		t.Errorf("unexpected first iface: %+v", ifaces[0])
	}
	if ifaces[1].ID != "Wireguard1" {
		t.Errorf("unexpected second iface: %+v", ifaces[1])
	}
}
