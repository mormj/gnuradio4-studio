// SPDX-License-Identifier: MIT
#include <cassert>
#include <chrono>
#include <future>
#include <gnuradio-4.0/studio/StudioDataSetSink.hpp>
#include <string>

gr::DataSet<double> spectrum(std::size_t count) {
    gr::DataSet<double> data;
    data.axis_names = {"frequency"};
    data.axis_units = {"Hz"};
    data.axis_values.resize(1);
    data.signal_names      = {"spectrum"};
    data.signal_units      = {"dBm"};
    data.signal_quantities = {"power"};
    data.extents           = {static_cast<std::int32_t>(count)};
    for (std::size_t i = 0; i < count; ++i) {
        data.axis_values[0].push_back(1000000.0 + static_cast<double>(i));
        data.signal_values.push_back(-static_cast<double>(i));
    }
    data.timestamp        = 1792586096000000001LL;
    data.meta_information = {gr::property_map{{"source_id", "test-source"}, {"sequence", std::uint64_t(9007199254740993ULL)}, {"nested", gr::property_map{{"actual_rbw", 956.25}}}}};
    return data;
}

namespace net   = boost::asio;
namespace beast = boost::beast;
namespace ws    = beast::websocket;
using tcp       = net::ip::tcp;
std::string receive(ws::stream<tcp::socket>& socket) {
    beast::flat_buffer buffer;
    socket.read(buffer);
    return beast::buffers_to_string(buffer.data());
}

int main() {
    gr::studio::StudioDataSetSink<double> sink;
    assert(sink.window_size.value == -1);
    gr::studio::detail::DataSetWindow<double> window;
    auto                                      data = spectrum(4096);
    window.push(std::span(&data, 1));
    auto json = window.snapshotJson();
    assert(json.find("\"points\":4096") != std::string::npos);
    assert(json.find("[1000000,") != std::string::npos);
    assert(json.find("[1004095,-4095]") != std::string::npos);

    window.configure(0, 0, 3);
    json = window.snapshotJson();
    assert(json.find("\"points\":3") != std::string::npos);
    assert(json.find("[1004093,-4093]") != std::string::npos);
    assert(json.find("[1000000,") == std::string::npos);
    window.configure(0, 0, -1);
    assert(window.snapshotJson().find("\"points\":4096") != std::string::npos);

    for (const auto invalid : {0, -2}) {
        bool refused = false;
        try {
            window.configure(0, 0, invalid);
        } catch (const gr::exception&) {
            refused = true;
        }
        assert(refused);
    }
    assert(json.find("\"signal_unit\":\"dBm\"") != std::string::npos);
    assert(json.find("\"axis_unit\":\"Hz\"") != std::string::npos);
    assert(json.find("1792586096000000001") != std::string::npos);
    assert(json.find("9007199254740993") != std::string::npos);
    assert(json.find("\"actual_rbw\":956.25") != std::string::npos);
    const auto next = spectrum(2);
    window.push(std::span(&next, 1));
    assert(window.snapshotJson().find("\"points\":2") != std::string::npos);

    auto sparse             = spectrum(5);
    sparse.signal_values[1] = std::numeric_limits<double>::quiet_NaN();
    sparse.signal_values[2] = std::numeric_limits<double>::infinity();
    sparse.signal_values[3] = -std::numeric_limits<double>::infinity();
    window.push(std::span(&sparse, 1));
    const auto sparse_json = window.snapshotJson();
    assert(sparse_json.find("[1000000,-0],[1000001,null],[1000002,null],[1000003,"
                            "null],[1000004,-4]") != std::string::npos);
    assert(sparse_json.find("1792586096000000001") != std::string::npos);
    bool sparse_failed = false;
    assert(window.take(window.subscribe(), sparse_failed)->json() == sparse_json && !sparse_failed);
    auto malformed              = sparse;
    malformed.axis_values[0][1] = std::numeric_limits<double>::quiet_NaN();
    window.push(std::span(&malformed, 1));
    bool rejected = false;
    try {
        (void)window.snapshotJson();
    } catch (const gr::exception&) {
        rejected = true;
    }
    assert(rejected);
    bool failed_axis = false;
    assert(!window.take(window.subscribe(), failed_axis) && failed_axis);
    window.push(std::span(&next, 1));

    // Backpressure retains one latest update, and WebSocket never invents an
    // axis.
    auto subscriber = window.subscribe();
    bool failed     = false;
    assert(window.take(subscriber, failed));
    assert(!window.take(subscriber, failed) && !failed);
    for (int i = 0; i < 20; ++i) {
        window.push(std::span(&next, 1));
    }
    assert(window.take(subscriber, failed)->json().find("\"points\":2") != std::string::npos);
    assert(!window.take(subscriber, failed));
    auto missing_axis = next;
    missing_axis.axis_values.clear();
    window.push(std::span(&missing_axis, 1));
    assert(window.snapshotJson().find("\"points\":2") != std::string::npos);
    assert(window.take(subscriber, failed)->json().find("\"points\":0") != std::string::npos);
    window.reset();
    assert(!window.take(window.subscribe(), failed));

    net::io_context io;
    tcp::acceptor   allocation(io, tcp::endpoint(net::ip::make_address("127.0.0.1"), 0));
    auto            port = allocation.local_endpoint().port();
    allocation.close();
    sink.endpoint = "http://127.0.0.1:" + std::to_string(port) + "/snapshot";
    sink.start();
    std::span<const gr::DataSet<double>> input(&sparse, 1);
    assert(sink.processBulk(input) == gr::work::Status::OK);
    httplib::Client http("127.0.0.1", port);
    auto            response = http.Get("/snapshot");
    assert(response && response->status == 200);
    const auto expected = response->body;
    sink.stop();
    allocation.open(tcp::v4());
    allocation.bind(tcp::endpoint(net::ip::make_address("127.0.0.1"), 0));
    port = allocation.local_endpoint().port();
    allocation.close();
    sink.transport = "websocket";
    sink.endpoint  = "ws://127.0.0.1:" + std::to_string(port) + "/spectrum";
    sink.poll_ms   = 1;
    sink.start();
    assert(sink.processBulk(input) == gr::work::Status::OK);
    auto connect = [&] {
        auto client = std::make_unique<ws::stream<tcp::socket>>(io);
        client->next_layer().connect(tcp::endpoint(net::ip::make_address("127.0.0.1"), port));
        client->handshake("127.0.0.1", "/spectrum");
        return client;
    };
    auto client = connect();
    assert(receive(*client) == expected);
    client->close(ws::close_code::normal);
    client = connect();
    assert(receive(*client) == expected);
    auto               stopping = std::async(std::launch::async, [&] { sink.stop(); });
    beast::flat_buffer buffer;
    beast::error_code  error;
    client->read(buffer, error);
    assert(error == ws::error::closed && client->reason().code == ws::close_code::normal);
    stopping.get();
    sink.start();
    assert(sink.accepted_items == 0);
    client = connect();
    input  = std::span(&next, 1);
    assert(sink.processBulk(input) == gr::work::Status::OK);
    assert(receive(*client).find("\"points\":2") != std::string::npos);
    client->close(ws::close_code::normal);
    sink.stop();
}
