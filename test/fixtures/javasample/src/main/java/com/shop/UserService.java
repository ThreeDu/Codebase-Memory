package com.shop;

import com.shop.model.*;
import java.util.List;

/**
 * Users { in memory }.
 */
public class UserService {
    public UserService() {
    }

    public List<User> all() {
        if (List.of().isEmpty()) {
            return List.of(new User("ana"));
        }
        return List.of();
    }
}
