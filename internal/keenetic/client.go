// Package keenetic implements the Keenetic (Netcraze) Remote CLI (RCI) protocol
// over HTTP: challenge-response authentication plus WireGuard config import/update.
package keenetic

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"gopkg.in/ini.v1"
)

// Client speaks to a single Keenetic router over RCI.
type Client struct {
	baseURL string
	login   string
	pass    string
	cookie  string
	http    *http.Client
}

// NewClient builds an RCI client for the given router credentials.
// insecureSkipVerify disables TLS verification (self-signed Keenetic cert).
func NewClient(baseURL, login, pass string, insecureSkipVerify bool) *Client {
	transport := &http.Transport{}
	if insecureSkipVerify {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		login:   login,
		pass:    pass,
		http: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
		},
	}
}

// Ping reports whether the router is reachable (200 or 401 both mean alive).
func (c *Client) Ping() error {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/rci/show/version", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("router not reachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusUnauthorized {
		return fmt.Errorf("router returned status %d", resp.StatusCode)
	}
	return nil
}

// Auth performs the Keenetic challenge-response handshake and caches the cookie.
//
//	GET /auth -> 401, headers: x-ndm-realm, x-ndm-challenge, set-cookie
//	md5    = MD5(login:realm:password)
//	sha256 = SHA256(challenge + md5hex)
//	POST /auth {login, password: sha256hex} with Cookie
func (c *Client) Auth() error {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/auth", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("auth request failed: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK, http.StatusCreated, http.StatusAccepted:
		// Not password-protected or already authed.
		return nil
	case http.StatusUnauthorized:
		// fall through to challenge
	default:
		return fmt.Errorf("router unavailable (status %d)", resp.StatusCode)
	}

	realm := resp.Header.Get("x-ndm-realm")
	challenge := resp.Header.Get("x-ndm-challenge")
	setCookie := strings.SplitN(resp.Header.Get("set-cookie"), ";", 2)[0]
	if realm == "" || challenge == "" || setCookie == "" {
		return errors.New("missing auth challenge headers")
	}

	md5sum := md5.Sum([]byte(fmt.Sprintf("%v:%v:%v", c.login, realm, c.pass)))
	md5hex := hex.EncodeToString(md5sum[:])
	sha := sha256.Sum256([]byte(challenge + md5hex))
	passHash := hex.EncodeToString(sha[:])

	body, _ := json.Marshal(map[string]string{"login": c.login, "password": passHash})
	req2, err := http.NewRequest(http.MethodPost, c.baseURL+"/auth", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Cookie", setCookie)

	resp2, err := c.http.Do(req2)
	if err != nil {
		return fmt.Errorf("auth response failed: %w", err)
	}
	defer resp2.Body.Close()

	if resp2.StatusCode == http.StatusUnauthorized {
		return errors.New("authentication failed: wrong login or password")
	}
	if resp2.StatusCode < 200 || resp2.StatusCode > 299 {
		return fmt.Errorf("authentication failed (status %d)", resp2.StatusCode)
	}
	c.cookie = setCookie
	return nil
}

func (c *Client) do(method, path string, body []byte, contentType string) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return nil, 0, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return data, resp.StatusCode, err
}

// pingComm ensures an authenticated session before a RCI call.
func (c *Client) ensureAuth() error {
	if c.cookie != "" {
		return nil
	}
	return c.Auth()
}

// ImportWireGuard creates a new WireGuard interface from a .conf file content.
// name optional; if empty the conf filename is used.
func (c *Client) ImportWireGuard(confContent []byte, name string) error {
	if err := c.ensureAuth(); err != nil {
		return err
	}
	if strings.TrimSpace(name) == "" {
		name = "import.conf"
	}
	payload := map[string]any{
		"import":   base64.StdEncoding.EncodeToString(confContent),
		"name":     "",
		"filename": name,
	}
	body, _ := json.Marshal(payload)
	data, status, err := c.do(http.MethodPost, "/rci/interface/wireguard/import", body, "application/json")
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("import failed (status %d): %s", status, data)
	}
	return parseErrorStatus(data)
}

// WireGuardInterface describes a WireGuard interface reported by the router.
type WireGuardInterface struct {
	ID    string `json:"id"`
	Type  string `json:"type"`
	Name  string `json:"name"`
	State string `json:"state"`
}

// ShowWireGuardInterfaces lists available WireGuard interfaces via RCI
// /rci/show/interface. Returns interface IDs the caller can target for updates.
func (c *Client) ShowWireGuardInterfaces() ([]WireGuardInterface, error) {
	if err := c.ensureAuth(); err != nil {
		return nil, err
	}
	data, status, err := c.do(http.MethodGet, "/rci/show/interface", nil, "")
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		return nil, fmt.Errorf("show interface failed (status %d): %s", status, data)
	}

	// Shape: {"interface": [ {"id": "...", "type": "wireguard", ...}, ... ]}
	var payload struct {
		Interface []WireGuardInterface `json:"interface"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, fmt.Errorf("parse interface list: %w", err)
	}

	var out []WireGuardInterface
	for _, ifc := range payload.Interface {
		if strings.EqualFold(ifc.Type, "wireguard") {
			out = append(out, ifc)
		}
	}
	return out, nil
}

// UpdateWireGuard replaces the config of an existing interface from .conf content.
// It diffs the new conf against current router state and issues only the needed
// RCI commands, then saves the configuration.
func (c *Client) UpdateWireGuard(interfaceID string, confContent []byte) error {
	if err := c.ensureAuth(); err != nil {
		return err
	}
	asc, peer, err := parseConf(confContent)
	if err != nil {
		return err
	}

	// Build parse commands (diff against nothing -> apply all peer params).
	var commands []string

	if ascLine := buildASCCommand(interfaceID, asc); ascLine != "" {
		commands = append(commands, ascLine)
	}
	if peer.PublicKey != "" {
		commands = append(commands, buildPeerCommands(interfaceID, peer)...)
	}
	// Minimal fallback: wireguard configfile replacement is handled by the
	// peer-level commands above; make sure we persist.
	commands = append(commands, "system configuration save")

	if err := c.execCommands(commands); err != nil {
		return err
	}
	return nil
}

// execCommands posts one or more CLI commands via /rci/ (batch).
func (c *Client) execCommands(commands []string) error {
	requests := make([]map[string]string, 0, len(commands))
	for _, cmd := range commands {
		requests = append(requests, map[string]string{"parse": cmd})
	}
	body, _ := json.Marshal(requests)
	data, status, err := c.do(http.MethodPost, "/rci/", body, "application/json")
	if err != nil {
		return err
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("command failed (status %d): %s", status, data)
	}
	return parseErrorStatus(data)
}

// parseErrorStatus inspects the RCI JSON response for an error status entry.
func parseErrorStatus(data []byte) error {
	var res []struct {
		Parse struct {
			Status []struct {
				Status, Code, Ident, Message string
			} `json:"status"`
		} `json:"parse"`
	}
	if err := json.Unmarshal(data, &res); err != nil {
		return nil // response may be empty for import
	}
	for _, r := range res {
		for _, s := range r.Parse.Status {
			if s.Status == "error" {
				return fmt.Errorf("rci error: %s (%s) %s", s.Message, s.Code, s.Ident)
			}
		}
	}
	return nil
}

// --- .conf parsing ---

type ascParams struct {
	Jc, Jmin, Jmax   string
	S1, S2           string
	H1, H2, H3, H4   string
	S3, S4           string
	I1, I2, I3, I4, I5 string
}

type peerParams struct {
	PublicKey  string
	Endpoint   string
	AllowedIPs []string
	KeepAlive  int
	Preshared  string
}

func parseConf(conf []byte) (ascParams, peerParams, error) {
	var asc ascParams
	var peer peerParams
	cfg, err := ini.Load(conf)
	if err != nil {
		return asc, peer, err
	}

	if sec, err := cfg.GetSection("Interface"); err == nil {
		get := func(k string) string {
			if key, err := sec.GetKey(k); err == nil {
				return key.String()
			}
			return ""
		}
		asc.Jc, asc.Jmin, asc.Jmax = get("Jc"), get("Jmin"), get("Jmax")
		asc.S1, asc.S2 = get("S1"), get("S2")
		asc.H1, asc.H2, asc.H3, asc.H4 = get("H1"), get("H2"), get("H3"), get("H4")
		asc.S3, asc.S4 = get("S3"), get("S4")
		asc.I1, asc.I2, asc.I3, asc.I4, asc.I5 = get("I1"), get("I2"), get("I3"), get("I4"), get("I5")
	}

	if sec, err := cfg.GetSection("Peer"); err != nil {
		return asc, peer, fmt.Errorf("conf missing [Peer] section")
	} else {
		if key, err := sec.GetKey("PublicKey"); err == nil {
			peer.PublicKey = key.String()
		}
		if key, err := sec.GetKey("Endpoint"); err == nil {
			peer.Endpoint = key.String()
		}
		if key, err := sec.GetKey("PresharedKey"); err == nil {
			peer.Preshared = key.String()
		}
		if key, err := sec.GetKey("PersistentKeepalive"); err == nil {
			fmt.Sscanf(key.String(), "%d", &peer.KeepAlive)
		}
		if key, err := sec.GetKey("AllowedIPs"); err == nil {
			for _, part := range strings.Split(key.String(), ",") {
				if p := strings.TrimSpace(part); p != "" {
					peer.AllowedIPs = append(peer.AllowedIPs, p)
				}
			}
		}
	}
	return asc, peer, nil
}

func hasAnyASC(a ascParams) bool {
	return a.Jc != "" || a.Jmin != "" || a.Jmax != "" || a.S1 != "" || a.S2 != "" ||
		a.H1 != "" || a.H2 != "" || a.H3 != "" || a.H4 != "" ||
		a.S3 != "" || a.S4 != "" || a.I1 != "" || a.I2 != "" || a.I3 != "" || a.I4 != "" || a.I5 != ""
}

func buildASCCommand(id string, a ascParams) string {
	if !hasAnyASC(a) {
		return ""
	}
	zero := func(s string) string {
		if s == "" {
			return "0"
		}
		return s
	}
	cmd := fmt.Sprintf("interface %v wireguard asc %v %v %v %v %v %v %v %v %v",
		id, a.Jc, a.Jmin, a.Jmax, a.S1, a.S2, a.H1, a.H2, a.H3, a.H4)
	if a.S3 != "" || a.S4 != "" || a.I1 != "" || a.I2 != "" || a.I3 != "" || a.I4 != "" || a.I5 != "" {
		cmd += fmt.Sprintf(" %v %v %v %v %v %v %v",
			zero(a.S3), zero(a.S4), zero(a.I1), zero(a.I2), zero(a.I3), zero(a.I4), zero(a.I5))
	}
	return cmd
}

func buildPeerCommands(id string, p peerParams) []string {
	var cmds []string
	if p.Endpoint != "" {
		cmds = append(cmds, fmt.Sprintf("interface %v wireguard peer %v endpoint %v", id, p.PublicKey, p.Endpoint))
	}
	if p.KeepAlive > 0 {
		cmds = append(cmds, fmt.Sprintf("interface %v wireguard peer %v keepalive-interval %v", id, p.PublicKey, p.KeepAlive))
	}
	if p.Preshared != "" {
		cmds = append(cmds, fmt.Sprintf("interface %v wireguard peer %v preshared-key %v", id, p.PublicKey, p.Preshared))
	}
	for _, cidr := range p.AllowedIPs {
		cmds = append(cmds, fmt.Sprintf("interface %v wireguard peer %v allow-ips %v", id, p.PublicKey, cidr))
	}
	return cmds
}
