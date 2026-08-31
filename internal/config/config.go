package config

import (
	"os"
	"strconv"
	"strings"
)

// Config holds runtime settings loaded from environment variables.
type Config struct {
	TelegramToken string
	StorePath     string
	TLSSkipVerify bool
	AllowedIDs    map[int64]bool
	AdminIDs      map[int64]bool
}

// FromEnv loads configuration from environment variables with defaults.
func FromEnv() *Config {
	cfg := &Config{
		TelegramToken: os.Getenv("TG_BOT_TOKEN"),
		StorePath:     getenv("STORE_PATH", "data/state.json"),
		TLSSkipVerify: os.Getenv("TLSSKIPVERIFY") == "1" || os.Getenv("TLSSKIPVERIFY") == "true",
		AllowedIDs:    map[int64]bool{},
		AdminIDs:      map[int64]bool{},
	}
	parseIDs := func(raw string, into map[int64]bool) {
		for _, part := range strings.Split(raw, ",") {
			if id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64); err == nil {
				into[id] = true
			}
		}
	}
	parseIDs(os.Getenv("TG_ALLOWED_IDS"), cfg.AllowedIDs)
	parseIDs(os.Getenv("TG_ADMIN_IDS"), cfg.AdminIDs)
	return cfg
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
