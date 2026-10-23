// SPDX-License-Identifier: MIT
#pragma once
#include <boost/asio.hpp>
#include <boost/beast.hpp>
#include <gnuradio-4.0/studio/StudioDataSetWaterfallStore.hpp>
#include <thread>

namespace gr::studio::dataset_waterfall {
// One I/O executor; each client has its own bounded ordered native transaction
// queue. All serialization and socket operations execute here, never in
// processBulk.
namespace net   = boost::asio;
namespace beast = boost::beast;
namespace ws    = beast::websocket;
using tcp       = net::ip::tcp;
template<typename StoreType, typename SubscriberType>
class BasicWebSocketService {
    struct Client : std::enable_shared_from_this<Client> {
        ws::stream<beast::tcp_stream>                 socket;
        net::steady_timer                             timer, drain_deadline;
        beast::flat_buffer                            input;
        beast::flat_buffer                            headers;
        beast::http::request<beast::http::empty_body> request;
        StoreType&                                    store;
        std::shared_ptr<SubscriberType>               subscriber;
        std::string                                   path, encoded;
        std::chrono::milliseconds                     interval;
        std::size_t                                   maxEncoded;
        bool                                          closed = false, draining = false, writing = false, closing_handshake = false, drained = false;
        std::function<void()>                         on_abandoned;
        Client(tcp::socket s, StoreType& st, std::string p, std::uint32_t ms, std::size_t bound) : socket(std::move(s)), timer(socket.get_executor()), drain_deadline(socket.get_executor()), store(st), path(std::move(p)), interval(ms), maxEncoded(bound) {}
        void close() {
            if (closed) {
                return;
            }
            closed = true;
            if (draining && subscriber && !drained && on_abandoned) {
                on_abandoned();
            }
            subscriber.reset();
            drain_deadline.cancel();
            timer.cancel();
            beast::error_code ec;
            beast::get_lowest_layer(socket).socket().shutdown(tcp::socket::shutdown_both, ec);
            beast::get_lowest_layer(socket).socket().close(ec);
        }
        void start() {
            auto self = this->shared_from_this();
            beast::get_lowest_layer(socket).expires_after(std::chrono::seconds(2));
            beast::http::async_read(socket.next_layer(), headers, request, [self](beast::error_code ec, std::size_t) {
                if (ec || self->request.target() != self->path || !ws::is_upgrade(self->request)) {
                    self->close();
                    return;
                }
                self->socket.set_option(ws::stream_base::timeout{std::chrono::seconds(2), std::chrono::seconds(10), true});
                self->socket.async_accept(self->request, [self](beast::error_code err) {
                    if (err) {
                        self->close();
                        return;
                    }
                    // TCP handshake deadlines must not survive the WebSocket
                    // upgrade. The WebSocket timeout now owns liveness and
                    // keepalive handling.
                    beast::get_lowest_layer(self->socket).expires_never();
                    self->subscriber = self->store.subscribe();
                    if (!self->subscriber) {
                        self->close();
                        return;
                    }
                    self->read();
                    self->send();
                });
            });
        }
        void read() {
            auto self = this->shared_from_this();
            socket.read_message_max(1024);
            socket.async_read(input, [self](beast::error_code ec, std::size_t) {
                if (ec) {
                    if (ec == ws::error::closed && self->closing_handshake) {
                        self->drained = true;
                    }
                    self->close();
                    return;
                }
                // This is a server-push stream; application messages are unsupported.
                self->close();
            });
        }
        void drain(std::function<void()> abandoned) {
            if (closed) {
                return;
            }
            draining     = true;
            on_abandoned = std::move(abandoned);
            if (!subscriber) {
                close();
                return;
            }
            drain_deadline.expires_after(std::chrono::seconds(2));
            auto self = this->shared_from_this();
            drain_deadline.async_wait([self](beast::error_code ec) {
                if (!ec) {
                    self->close();
                }
            });
            timer.cancel();
            if (!writing) {
                send();
            }
        }
        void send() {
            if (closed || closing_handshake || writing) {
                return;
            }
            bool failed = false;
            auto t      = store.take(subscriber, failed);
            if (failed) {
                close();
                return;
            }
            auto self = this->shared_from_this();
            if (!t) {
                if (draining) {
                    closing_handshake = true;
                    socket.async_close(ws::close_code::normal, [self](beast::error_code ec) {
                        self->drained = !ec;
                        self->close();
                    });
                    return;
                }
                timer.expires_after(interval);
                timer.async_wait([self](beast::error_code ec) {
                    if (!ec) {
                        self->send();
                    }
                });
                return;
            }
            encoded = t->json();
            if (encoded.size() > maxEncoded) {
                close();
                return;
            }
            socket.text(true);
            writing = true;
            socket.async_write(net::buffer(encoded), [self](beast::error_code ec, std::size_t) {
                self->writing = false;
                if (ec) {
                    self->close();
                    return;
                }
                self->encoded.clear();
                self->send();
            });
        }
    };
    net::io_context                    io;
    std::unique_ptr<tcp::acceptor>     acceptor;
    std::vector<std::weak_ptr<Client>> clients;
    std::thread                        thread;
    std::uint64_t                      abandoned = 0;
    StoreType*                         store     = nullptr;
    std::string                        path;
    std::uint32_t                      interval   = 100;
    std::size_t                        maxClients = 8, maxEncoded = 128 * 1024 * 1024;
    void                               accept() {
        acceptor->async_accept([this](beast::error_code ec, tcp::socket socket) {
            if (!ec) {
                std::erase_if(clients, [](auto& c) {
                    auto p = c.lock();
                    return !p || p->closed;
                });
                if (clients.size() < maxClients) {
                    auto c = std::make_shared<Client>(std::move(socket), *store, path, interval, maxEncoded);
                    clients.push_back(c);
                    c->start();
                }
            }
            if (acceptor && acceptor->is_open()) {
                accept();
            }
        });
    }

public:
    ~BasicWebSocketService() { stop(); }
    void start(StoreType& st, const std::string& host, std::uint16_t port, std::string p, std::uint32_t ms, std::size_t count, std::size_t encoded) {
        stop();
        abandoned = 0;
        io.restart();
        store        = &st;
        path         = std::move(p);
        interval     = std::max(1U, ms);
        maxClients   = count;
        maxEncoded   = encoded;
        auto address = net::ip::make_address(host);
        acceptor     = std::make_unique<tcp::acceptor>(io);
        acceptor->open(address.is_v6() ? tcp::v6() : tcp::v4());
        acceptor->set_option(net::socket_base::reuse_address(true));
        acceptor->bind(tcp::endpoint(address, port));
        acceptor->listen();
        accept();
        thread = std::thread([this] { io.run(); });
    }
    std::uint16_t port() const { return acceptor->local_endpoint().port(); }
    std::uint64_t stop() {
        if (thread.joinable()) {
            net::post(io, [this] {
                beast::error_code ec;
                acceptor->close(ec);
                for (auto& w : clients) {
                    if (auto c = w.lock()) {
                        c->drain([this] { ++abandoned; });
                    }
                }
            });
            thread.join();
        }
        clients.clear();
        acceptor.reset();
        return abandoned;
    }
};
using WebSocketService = BasicWebSocketService<Store, Subscriber>;
} // namespace gr::studio::dataset_waterfall
