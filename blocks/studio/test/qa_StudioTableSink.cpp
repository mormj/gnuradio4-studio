// SPDX-License-Identifier: MIT
#include <cassert>
#include <fstream>
#include <gnuradio-4.0/studio/StudioSyntheticTableSource.hpp>
#include <gnuradio-4.0/studio/StudioTableSink.hpp>
#include <iostream>
using namespace gr::studio;
using namespace gr::studio::tables;
using gr::property_map;
gr::DataSet<double> update(std::uint64_t batch, std::uint64_t revision, const std::string& id = "region") {
    SyntheticTableSource source;
    source.run_namespace     = "test-run";
    source.producer_instance = "tables";
    source.start();
    auto d                                          = source.next();
    d.meta_information[0]["producer_batch_ordinal"] = batch;
    auto& rows                                      = *d.meta_information[0].at("rows").get_if<property_map>();
    auto& event                                     = *rows.at("0").get_if<property_map>();
    auto& a                                         = *event.at("value").get_if<property_map>();
    a["row_id"]                                     = id;
    a["revision"]                                   = revision;
    return d;
}
property_map& event(gr::DataSet<double>& d) { return *d.meta_information[0].at("rows").get_if<property_map>()->at("0").get_if<property_map>(); }
property_map& value(gr::DataSet<double>& d) { return *event(d).at("value").get_if<property_map>(); }
std::string   receive(dataset_waterfall::ws::stream<dataset_waterfall::tcp::socket>& socket) {
    dataset_waterfall::beast::flat_buffer b;
    socket.read(b);
    return dataset_waterfall::beast::buffers_to_string(b.data());
}
int main(int argc, char** argv) {
    Config c;
    c.run_namespace = "test-run";
    Store s;
    s.configure(c);
    {
        Config escaped            = c;
        escaped.run_namespace     = std::string(512, '\n');
        escaped.producer_instance = std::string(512, '\t');
        s.configure(escaped);
        auto client   = s.subscribe();
        bool failed   = false;
        auto captured = s.take(client, failed);
        assert(captured && captured->json().size() <= captured->bound);
        s.configure(c);
    }

    auto a = s.subscribe(), b = s.subscribe();
    bool failed = false;
    assert(s.take(a, failed)->snapshot);
    s.take(b, failed);
    assert(s.push(update(0, 9007199254740993ULL)));
    auto first = s.take(a, failed);
    assert(first && first->snapshot);
    assert(first->json() == s.take(b, failed)->json());
    assert(s.diagnostics()[5] == 1);
    assert(s.push(update(1, 9007199254740994ULL)));
    assert(s.diagnostics()[5] == 1);
    assert(s.push(update(2, 9007199254740993ULL)));
    assert(s.diagnostics()[2] == 1);
    assert(s.push(update(3, 9007199254740994ULL)));
    assert(s.diagnostics()[1] == 1);
    auto d                                                    = update(4, 9007199254740994ULL);
    value(d).at("values").get_if<property_map>()->at("state") = std::string("conflict");
    auto before                                               = s.snapshot();
    assert(!s.push(d));
    assert(s.diagnostics()[3] == 1);
    s.take(a, failed);
    assert(failed);
    assert(s.snapshot().find("conflict") == std::string::npos);
    assert(!s.subscribe());
    s.configure(c);
    assert(s.push(update(0, UINT64_MAX)));
    assert(s.snapshot().find("18446744073709551615") != std::string::npos);
    s.configure(c);
    assert(s.push(update(0, 1)));
    d        = update(1, 2);
    event(d) = {{"operation", std::string("delete")}, {"row_id", std::string("region")}, {"revision", std::uint64_t(2)}};
    assert(s.push(d));
    assert(s.snapshot().find("\"rows\":[]") != std::string::npos);
    assert(s.snapshot().find("\"tombstones\":[{") != std::string::npos);
    assert(s.push(update(2, 1)));
    assert(s.snapshot().find("\"rows\":[]") != std::string::npos);
    assert(s.push(update(3, 3)));
    d        = update(4, 4);
    event(d) = {{"operation", std::string("clear")}};
    assert(s.push(d));
    assert(s.diagnostics()[5] == 0);
    s.configure(c);
    d = update(0, 1);
    assert(s.push(d));
    assert(s.push(d));
    assert(s.diagnostics()[1] == 1);
    value(d).at("values").get_if<property_map>()->at("state") = std::string("conflicting batch");
    assert(!s.push(d));
    assert(s.diagnostics()[3] == 1);
    s.configure(c);
    // All types are native PMTs, with no implicit integer/string/float
    // conversion.
    for (int i = 0; i < 10; i++) {
        d       = update(10 + i, 10 + i);
        auto& v = *value(d).at("values").get_if<property_map>();
        if (i == 0) {
            value(d)["revision"] = 9007199254740993.0;
        }
        if (i == 1) {
            v["identity"] = 9007199254740993.0;
        }
        if (i == 2) {
            v["frequency"] = std::uint64_t(10);
        }
        if (i == 3) {
            v["power"] = NAN;
        }
        if (i == 4) {
            d.extents = {2};
        }
        if (i == 5) {
            v["state"] = std::string(4097, 'x');
        }
        if (i == 6) {
            value(d)["unexpected"] = true;
        }
        if (i == 7) {
            d.axis_values[0][0] = NAN;
        }
        if (i == 8) {
            v["reason"] = false;
        }
        if (i == 9) {
            v.erase("offset");
        }
        assert(!s.push(d));
    }
    s.configure(c);
    d                 = update(0, 1);
    auto& exact       = *value(d).at("values").get_if<property_map>();
    exact["identity"] = UINT64_MAX;
    exact["offset"]   = std::int64_t(INT64_MAX);
    assert(s.push(d));
    assert(s.snapshot().find("18446744073709551615") != std::string::npos);
    assert(s.snapshot().find("9223372036854775807") != std::string::npos);
    // Explicit initial native schema is retained even without rows.
    c.columns = SyntheticTableSource::schema();
    s.configure(c);
    assert(s.snapshot().find("identity") != std::string::npos);
    assert(s.diagnostics()[5] == 0);
    c.columns.clear();
    // New schema atomically replaces rows and rotates epoch, including an empty
    // schema update.
    s.configure(c);
    assert(s.push(update(0, 1)));
    a = s.subscribe();
    s.take(a, failed);
    d                                                = update(1, 2);
    auto& cols                                       = *d.meta_information[0].at("columns").get_if<property_map>();
    cols.at("0").get_if<property_map>()->at("label") = std::string("Renamed identity");
    assert(s.push(d));
    assert(s.take(a, failed)->snapshot);
    d                                     = update(2, 3);
    d.extents                             = {0};
    d.axis_values                         = {{}};
    d.signal_values                       = {};
    d.meta_information[0]["update_count"] = std::uint64_t(0);
    d.meta_information[0]["rows"]         = property_map{};
    d.meta_information[0]["columns"]      = property_map{};
    assert(s.push(d));
    assert(s.take(a, failed)->snapshot);
    assert(s.diagnostics()[5] == 0);
    // Bounded authoritative snapshot, explicit eviction and tombstone pruning
    // epoch reset.
    c.max_items = 2;
    s.configure(c);
    a = s.subscribe();
    s.take(a, failed);
    assert(s.push(update(0, 1, "a")));
    s.take(a, failed);
    assert(s.push(update(1, 1, "b")));
    s.take(a, failed);
    assert(s.push(update(2, 1, "c")));
    auto eviction = s.take(a, failed);
    assert(eviction->json().find("\"evicted_ids\":[\"a\"]") != std::string::npos);
    assert(s.diagnostics()[5] == 2);
    s.configure(c);
    d        = update(0, 1);
    event(d) = {{"operation", std::string("delete")}, {"row_id", std::string("dead")}, {"revision", std::uint64_t(1)}};
    assert(s.push(d));
    auto epochBefore = s.snapshot();
    assert(s.push(update(1, 1, "b")));
    a = s.subscribe();
    s.take(a, failed);
    assert(s.push(update(2, 1, "c")));
    assert(s.take(a, failed)->snapshot);
    // Closed rows are retained until pressure; evict closed before older active
    // rows.
    s.configure(c);
    assert(s.push(update(0, 1, "active")));
    d                                                         = update(1, 1, "closed");
    value(d)["terminal"]                                      = true;
    value(d).at("values").get_if<property_map>()->at("state") = std::string("application-defined");
    assert(s.push(d));
    a = s.subscribe();
    s.take(a, failed);
    assert(s.push(update(2, 1, "new")));
    assert(s.take(a, failed)->json().find("\"evicted_ids\":[\"closed\"]") != std::string::npos);
    // No table column is reserved for lifecycle policy. The word CLOSED is
    // ordinary data, including when an explicit terminal flag is false.
    for (bool explicitFlag : {false, true}) {
        s.configure(c);
        assert(s.push(update(0, 1, "oldest")));
        d                                                         = update(1, 1, "labelled");
        value(d).at("values").get_if<property_map>()->at("state") = std::string("CLOSED");
        if (explicitFlag) {
            value(d)["terminal"] = false;
        } else {
            value(d).erase("terminal");
        }
        assert(s.push(d));
        a = s.subscribe();
        s.take(a, failed);
        assert(s.push(update(2, 1, "newest")));
        assert(s.take(a, failed)->json().find("\"evicted_ids\":[\"oldest\"]") != std::string::npos);
    }
    s.configure(c);
    d                    = update(0, 1);
    value(d)["terminal"] = std::string("true");
    assert(!s.push(d) && s.diagnostics()[5] == 0);
    c.max_clients = 2;
    s.configure(c);
    a = s.subscribe();
    b = s.subscribe();
    assert(a && b && !s.subscribe());
    c.max_clients = 8;
    // Per-client overflow never skips publication transactions.
    c.max_items   = 10000;
    c.queue_bytes = 1024;
    s.configure(c);
    a = s.subscribe();
    s.take(a, failed);
    for (std::uint64_t i = 0; i < 10; ++i) {
        assert(s.push(update(i, i + 1)));
    }
    s.take(a, failed);
    assert(failed && s.diagnostics()[4] == 1);
    // Shared stream transport: independent viewers, reconnect running/idle,
    // snapshot barrier.
    c.queue_bytes = 4 * 1024 * 1024;
    s.configure(c);
    dataset_waterfall::BasicWebSocketService<Store, Subscriber> service;
    service.start(s, "127.0.0.1", 0, "/tables", 1, 8, c.snapshot_bytes);
    dataset_waterfall::net::io_context io;
    auto                               connect = [&] {
        auto w = std::make_unique<dataset_waterfall::ws::stream<dataset_waterfall::tcp::socket>>(io);
        w->next_layer().connect({dataset_waterfall::net::ip::make_address("127.0.0.1"), service.port()});
        w->handshake("127.0.0.1", "/tables");
        return w;
    };
    auto w1 = connect(), w2 = connect();
    assert(receive(*w1) == receive(*w2));
    assert(s.push(update(0, 1)));
    assert(receive(*w1) == receive(*w2));
    w1->close(dataset_waterfall::ws::close_code::normal);
    assert(s.push(update(1, 2)));
    receive(*w2);
    w1 = connect();
    assert(receive(*w1).find("\"revision\":\"2\"") != std::string::npos);
    w2->close(dataset_waterfall::ws::close_code::normal);
    w2 = connect();
    assert(receive(*w2).find("\"message\":\"snapshot\"") != std::string::npos);
    w1->close(dataset_waterfall::ws::close_code::normal);
    w2->close(dataset_waterfall::ws::close_code::normal);
    service.stop();
    // Actual table socket overflow: client closes and reconnects to a complete
    // snapshot.
    c.queue_bytes = 1024;
    s.configure(c);
    assert(s.push(update(0, 1)));
    service.start(s, "127.0.0.1", 0, "/tables", 1, 8, c.snapshot_bytes);
    w1 = connect();
    receive(*w1);
    assert(s.push(update(1, 2)));
    dataset_waterfall::beast::flat_buffer buffer;
    dataset_waterfall::beast::error_code  ec;
    w1->read(buffer, ec);
    assert(ec && s.diagnostics()[4] == 1);
    w1 = connect();
    assert(receive(*w1).find("\"revision\":\"2\"") != std::string::npos);
    w1->close(dataset_waterfall::ws::close_code::normal);
    service.stop();
    c.queue_bytes = 4 * 1024 * 1024;
    c.max_bytes   = 8192;
    s.configure(c);
    assert(!s.push(update(0, 1)));
    assert(s.diagnostics()[5] == 0);
    c.max_bytes = 32 * 1024 * 1024;
    // Prior qualification workload: 3014 creations, 16185 updates, closed
    // history, exact large IDs.
    s.configure(c);
    auto start = std::chrono::steady_clock::now();
    for (std::uint64_t i = 0; i < 16185; ++i) {
        d = update(i, i + 1, "region-" + std::to_string(9007199254740993ULL + i % 3014));
        if (i >= 13171) {
            value(d).at("values").get_if<property_map>()->at("state") = std::string("closed");
        }
        assert(s.push(d));
    }
    auto seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
    assert(s.diagnostics()[5] == 3014);
    auto snap = s.snapshot();
    if (argc > 1) {
        std::ofstream(argv[1]) << snap;
    }
    std::cout << "PASS table "
                 "revisions/delete/clear/geometry/retention/reconnect/overflow; "
                 "creations=3014 updates=16185 retained="
              << s.diagnostics()[5] << " updates_per_second=" << 16185 / seconds << " snapshot_bytes=" << snap.size() << '\n';
}
