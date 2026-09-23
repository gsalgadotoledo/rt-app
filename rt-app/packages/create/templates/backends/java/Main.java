import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.Executors;

// Application endpoints live here; existing RT-App modules use the local Node core.
class Main {
 public static void main(String[] args) throws Exception {
  URI core=URI.create(System.getenv("RT_APP_CORE_API_URL"));
  if(!"http".equals(core.getScheme())||!"127.0.0.1".equals(core.getHost())||core.getPort()<1)throw new IllegalArgumentException("Core must be a loopback HTTP service");
  var blocked=Set.of("host","connection","content-length","transfer-encoding","upgrade","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","expect");
  var client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
  int port=Integer.parseInt(System.getenv().getOrDefault("PORT","4010"));
  var server=HttpServer.create(new InetSocketAddress("127.0.0.1",port),128);
  server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
  server.createContext("/",exchange->{
   try {
    String path=exchange.getRequestURI().getRawPath();
    if(exchange.getRequestMethod().equals("GET")&&(path.equals("/hello")||path.equals("/health"))){
     byte[] data=(path.equals("/health")?"{\"ok\":true}":"{\"message\":\"Hello from Java\",\"language\":\"java\"}").getBytes(StandardCharsets.UTF_8);
     exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(200,data.length);exchange.getResponseBody().write(data);return;
    }
    byte[] input=exchange.getRequestBody().readNBytes(16385);
    if(input.length>16384){exchange.sendResponseHeaders(413,-1);return;}
    // Append a path to the fixed origin; do not URI.resolve an untrusted //host path.
    String rawPath="/"+path.replaceFirst("^/+","");String query=exchange.getRequestURI().getRawQuery();
    var request=HttpRequest.newBuilder(URI.create(core.toString()+rawPath+(query==null?"":"?"+query))).timeout(Duration.ofSeconds(15));
    exchange.getRequestHeaders().forEach((key,values)->{if(!blocked.contains(key.toLowerCase()))values.forEach(value->request.header(key,value));});
    var response=client.send(request.method(exchange.getRequestMethod(),HttpRequest.BodyPublishers.ofByteArray(input)).build(),HttpResponse.BodyHandlers.ofByteArray());
    response.headers().map().forEach((key,values)->{if(!blocked.contains(key.toLowerCase()))exchange.getResponseHeaders().put(key,values);});
    boolean empty=exchange.getRequestMethod().equals("HEAD")||response.statusCode()==204||response.statusCode()==304;
    exchange.sendResponseHeaders(response.statusCode(),empty?-1:response.body().length);if(!empty)exchange.getResponseBody().write(response.body());
   }catch(Exception error){try{exchange.sendResponseHeaders(502,-1);}catch(Exception ignored){}}
   finally{exchange.close();}
  });
  Runtime.getRuntime().addShutdownHook(new Thread(()->server.stop(1)));
  server.start();System.out.println("Java API: http://localhost:"+port);
 }
}
