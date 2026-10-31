package com.shop;

import com.shop.model.User;
import java.util.List;

public class App {
    private final UserService service = new UserService();

    public static void main(String[] args) {
        new App().run();
    }

    void run() {
        List<User> users = service.all();
        System.out.println(users.size());
    }
}
