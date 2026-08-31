package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Binding describes a router attached to a Telegram user.
// Every user owns their own router(s); one binding maps a chat to one Keenetic URL.
type Binding struct {
	ChatID   int64  `json:"chat_id"`
	Name     string `json:"name"`
	URL      string `json:"url"`      // e.g. https://myrouter.keenetic.link
	Login    string `json:"login"`    // Keenetic admin login
	Password string `json:"password"` // Keenetic admin password
	// If empty, the first WireGuard interface on the router is targeted.
	InterfaceID string `json:"interface_id,omitempty"`
}

// Store is a simple JSON-file-backed store of user bindings.
type Store struct {
	mu       sync.Mutex
	path     string
	bindings []*Binding
}

var (
	ErrNoBinding   = errors.New("no router bound to this account yet")
	ErrNotFound    = errors.New("binding not found")
	ErrBindingName = errors.New("binding name already in use")
)

// New loads (or creates) the store file.
func New(path string) (*Store, error) {
	s := &Store{path: path}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, s.save()
		}
		return nil, err
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &s.bindings); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) save() error {
	data, err := json.MarshalIndent(s.bindings, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Add inserts a new binding for a user under a unique per-user name.
func (s *Store) Add(b *Binding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.bindings {
		if existing.ChatID == b.ChatID && existing.Name == b.Name {
			return ErrBindingName
		}
	}
	s.bindings = append(s.bindings, b)
	return s.save()
}

// Update replaces an existing binding (matched by chat+name).
func (s *Store) Update(b *Binding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.bindings {
		if existing.ChatID == b.ChatID && existing.Name == b.Name {
			s.bindings[i] = b
			return s.save()
		}
	}
	return ErrNotFound
}

// Remove deletes a binding by chat and name.
func (s *Store) Remove(chatID int64, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, b := range s.bindings {
		if b.ChatID == chatID && b.Name == name {
			s.bindings = append(s.bindings[:i], s.bindings[i+1:]...)
			return s.save()
		}
	}
	return ErrNotFound
}

// Get returns a binding for a user. If name is empty and only one binding
// exists, it is returned; otherwise first matching name.
func (s *Store) Get(chatID int64, name string) (*Binding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var named []*Binding
	for _, b := range s.bindings {
		if b.ChatID == chatID {
			if name != "" && b.Name == name {
				return b, nil
			}
			named = append(named, b)
		}
	}
	if name == "" && len(named) == 1 {
		return named[0], nil
	}
	if name == "" && len(named) > 1 {
		return nil, errors.New("multiple routers bound; specify name (see /routers)")
	}
	return nil, ErrNoBinding
}

// List returns all bindings for a user.
func (s *Store) List(chatID int64) []*Binding {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*Binding
	for _, b := range s.bindings {
		if b.ChatID == chatID {
			out = append(out, b)
		}
	}
	return out
}

// GetAny returns a binding by owner chatID (admins may pass any chatID).
// Equivalent to Get but useful for cross-user management.
func (s *Store) GetAny(chatID int64, name string) (*Binding, error) {
	return s.Get(chatID, name)
}

// All returns every binding in the store (for admins).
func (s *Store) All() []*Binding {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Binding, len(s.bindings))
	copy(out, s.bindings)
	return out
}

// RemoveByID removes a binding by its exact partner chat+name regardless of caller,
// returning an error if not found. Used by admins for cross-user management.
func (s *Store) RemoveByID(ownerChatID int64, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, b := range s.bindings {
		if b.ChatID == ownerChatID && b.Name == name {
			s.bindings = append(s.bindings[:i], s.bindings[i+1:]...)
			return s.save()
		}
	}
	return ErrNotFound
}
