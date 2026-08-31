package main

import (
	"log"
	"net/http"
	"os"

	"github.com/zagbor/vpn_changer/internal/config"
	"github.com/zagbor/vpn_changer/internal/store"
	"github.com/zagbor/vpn_changer/internal/telegram"
)

func main() {
	cfg := config.FromEnv()
	if cfg.TelegramToken == "" {
		log.Fatal("TG_BOT_TOKEN environment variable is required")
	}

	st, err := store.New(cfg.StorePath)
	if err != nil {
		log.Fatalf("failed to init store: %v", err)
	}

	bot, err := telegram.New(cfg, st)
	if err != nil {
		log.Fatalf("failed to init telegram bot: %v", err)
	}

	// Health endpoint so Fly.io (http_service) keeps the machine alive.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("ok"))
		})
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("VPN Changer bot is running"))
		})
		if err := http.ListenAndServe(":"+port, mux); err != nil {
			log.Printf("health server stopped: %v", err)
		}
	}()

	log.Println("VPN Changer bot started")
	if err := bot.Run(); err != nil {
		log.Fatal(err)
	}
}
